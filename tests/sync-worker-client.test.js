/**
 * Bun-compatible tests for sync-worker-client.js.
 *
 * Tests worker-only sync enforcement, automatic recovery, and degraded state
 * notification. Uses only shallow mocks for the client module's direct
 * dependencies — no deep transitive mocking required.
 *
 * The deeper sync-worker.js module tests (batching, staleness, progress) live
 * in sync-worker.test.js and require vitest's vi.resetModules() + deep mocking.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportDecryptedKeys } from '../src/crypto/group-keys.js';
import { importTowerTransports } from '../src/tower-transport.js';
import { exportWorkspaceKeyForWorker } from '../src/crypto/workspace-keys.js';

vi.mock('../src/auth/nostr.js', () => ({
  getExtensionPublicKey: vi.fn(async () => 'pubkey-hex'),
  signEventWithExtension: vi.fn(async (event) => event),
}));

vi.mock('../src/crypto/group-keys.js', () => ({
  exportDecryptedKeys: vi.fn(() => []),
  decryptPayloadForGroup: vi.fn(),
  encryptPayloadForGroup: vi.fn(),
  getActiveSessionNpub: vi.fn(() => null),
  getGroupKey: vi.fn(() => null),
  getLoadedGroupKeyDiagnostics: vi.fn(() => ({})),
  hasGroupKey: vi.fn(() => false),
}));

vi.mock('../src/crypto/workspace-keys.js', () => ({
  exportWorkspaceKeyForWorker: vi.fn(() => null),
}));

let client;

beforeAll(async () => {
  client = await import('../src/sync-worker-client.js');
});

describe('worker-only sync enforcement', () => {
  let originalWorker;

  beforeEach(() => {
    originalWorker = globalThis.Worker;
  });

  afterEach(() => {
    client.shutdownSyncWorker();
    client.setWorkerDegradedCallback(null);
    if (originalWorker === undefined) {
      delete globalThis.Worker;
    } else {
      globalThis.Worker = originalWorker;
    }
  });

  it('rejects sync when Worker API is not available (no local fallback)', async () => {
    delete globalThis.Worker;

    await expect(
      client.runSync('npub-owner', 'npub-viewer', undefined, { backendUrl: 'https://x.com' }),
    ).rejects.toThrow(/Sync unavailable.*Web Workers/);
  });

  it('rejects sync when Worker constructor throws (no local fallback)', async () => {
    globalThis.Worker = class {
      constructor() { throw new Error('Worker construction blocked by CSP'); }
    };

    await expect(
      client.runSync('npub-owner', 'npub-viewer', undefined, { backendUrl: 'https://x.com' }),
    ).rejects.toThrow(/Sync unavailable/);
  });

  it('routes sync through the worker and returns results', async () => {
    class MockWorker {
      constructor() { this.onmessage = null; }
      addEventListener(type, handler) {
        if (type === 'message') this.onmessage = handler;
      }
      removeEventListener() {}
      terminate() {}
      postMessage(message) {
        if (message.type !== 'sync-worker:request') return;
        Promise.resolve().then(() => {
          this.onmessage?.({
            data: {
              type: 'sync-worker:response',
              id: message.id,
              ok: true,
              value: { pushed: 3, pulled: 1, pruned: 0 },
            },
          });
        });
      }
    }

    globalThis.Worker = MockWorker;

    const result = await client.runSync('npub-owner', 'npub-viewer', undefined, {
      backendUrl: 'https://backend.example.com',
    });
    expect(result).toEqual({ pushed: 3, pulled: 1, pruned: 0 });
  });

  it('flushOnly routes through the worker path', async () => {
    class MockWorker {
      constructor() { this.onmessage = null; }
      addEventListener(type, handler) {
        if (type === 'message') this.onmessage = handler;
      }
      removeEventListener() {}
      terminate() {}
      postMessage(message) {
        if (message.type !== 'sync-worker:request') return;
        expect(message.method).toBe('flushOnly');
        Promise.resolve().then(() => {
          this.onmessage?.({
            data: {
              type: 'sync-worker:response',
              id: message.id,
              ok: true,
              value: { pushed: 5 },
            },
          });
        });
      }
    }

    globalThis.Worker = MockWorker;

    const result = await client.flushOnly('npub-owner', null, {
      backendUrl: 'https://backend.example.com',
    });
    expect(result).toEqual({ pushed: 5 });
  });

  it('logout shutdown cancels active and queued writes without recovery or replay into a new worker', async () => {
    const created = [];
    globalThis.Worker = class {
      constructor() { created.push(this); this.messages = []; this.terminated = false; }
      addEventListener() {} removeEventListener() {}
      postMessage(message) { this.messages.push(message); }
      terminate() { this.terminated = true; }
    };
    const active = client.flushOnly('alice', null, { workspaceDbKey: 'alice-partition' });
    const queued = client.flushOnly('alice', null, { workspaceDbKey: 'alice-partition' });
    const activeRejected = expect(active).rejects.toMatchObject({ name: 'AbortError' });
    const queuedRejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(created).toHaveLength(1);
    client.shutdownSyncWorker();
    client.connectSSE('bob', 'bob', 'http://localhost', 'bob-partition');
    await Promise.all([activeRejected, queuedRejected]);
    expect(created).toHaveLength(2);
    expect(created[0].terminated).toBe(true);
    expect(created[1].messages.some(message => message.type === 'sync-worker:request')).toBe(false);
  });

  it('detaches native requests before terminating a sync worker', () => {
    const originalWindow = globalThis.window;
    const order = [];
    globalThis.window = { fipsTransport: { version: 2, available: true,
      attachWorker: () => order.push('attach'), detachWorker: () => order.push('detach'),
    } };
    globalThis.Worker = class {
      addEventListener() {} removeEventListener() {} postMessage() {}
      terminate() { order.push('terminate'); }
    };
    try {
      client.connectSSE('owner', 'viewer', 'https://backend.example.com', 'workspace');
      client.shutdownSyncWorker();
      expect(order).toEqual(['attach', 'detach', 'terminate']);
    } finally {
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    }
  });

  it('sends the selected transport before starting SSE even if optional key export fails', () => {
    const messages = [];
    globalThis.Worker = class {
      addEventListener() {} removeEventListener() {} terminate() {}
      postMessage(message) { messages.push(message); }
    };
    const connection = { logicalTower: 'https://backend.example.com', mode: 'fips', error: 'Native bridge unavailable' };
    importTowerTransports([connection]);
    vi.mocked(exportDecryptedKeys).mockImplementationOnce(() => { throw new Error('keys unavailable'); });
    try {
      client.connectSSE('owner', 'viewer', connection.logicalTower, 'same-workspace');
      expect(messages[0]).toEqual({ type: 'sync-worker:tower-transports', towerTransports: [connection] });
      expect(messages[1]).toMatchObject({ type: 'sync-worker:sse-connect', backendUrl: connection.logicalTower, workspaceDbKey: 'same-workspace' });
    } finally { importTowerTransports([]); }
  });

  it('startWorkerFlushTimer sends checkout policy config to the worker runner', () => {
    const messages = [];
    class MockWorker {
      addEventListener() {}
      removeEventListener() {}
      terminate() {}
      postMessage(message) {
        messages.push(message);
      }
    }

    globalThis.Worker = MockWorker;
    vi.mocked(exportWorkspaceKeyForWorker).mockReturnValueOnce(null);

    client.startWorkerFlushTimer(
      'npub-owner',
      'https://backend.example.com',
      'workspace-db',
      { checkoutPolicyConfig: { familySuffixes: { task: 'checkout_required' } } },
    );

    expect(messages[0]).toMatchObject({ type: 'sync-worker:tower-transports', towerTransports: [] });
    expect(messages[1]).toMatchObject({
      type: 'sync-worker:bootstrap-keys',
      wsKey: null,
    });
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'sync-worker:start-flush-timer',
      ownerNpub: 'npub-owner',
      backendUrl: 'https://backend.example.com',
      workspaceDbKey: 'workspace-db',
      options: {
        checkoutPolicyConfig: { familySuffixes: { task: 'checkout_required' } },
      },
    }));
  });

  it('connectSSE sends checkout policy config to the worker runner', () => {
    const messages = [];
    class MockWorker {
      addEventListener() {}
      removeEventListener() {}
      terminate() {}
      postMessage(message) {
        messages.push(message);
      }
    }

    globalThis.Worker = MockWorker;
    vi.mocked(exportWorkspaceKeyForWorker).mockReturnValueOnce({
      npub: 'npub1workspacekey',
      workspaceUserKeyNpub: 'npub1workspacekey',
      workspaceOwnerNpub: 'npub1owner',
      workspaceServiceNpub: 'npub1owner',
      userNpub: 'npub1user',
      registered: true,
    });

    client.connectSSE(
      'npub-owner',
      'npub-viewer',
      'https://backend.example.com',
      'workspace-db',
      { checkoutPolicyConfig: { familySuffixes: { task: 'checkout_required' } } },
    );

    expect(messages[0]).toMatchObject({ type: 'sync-worker:tower-transports', towerTransports: [] });
    expect(messages[1]).toMatchObject({
      type: 'sync-worker:bootstrap-keys',
      wsKey: {
        workspaceUserKeyNpub: 'npub1workspacekey',
        workspaceServiceNpub: 'npub1owner',
        registered: true,
      },
    });
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'sync-worker:sse-connect',
      ownerNpub: 'npub-owner',
      viewerNpub: 'npub-viewer',
      backendUrl: 'https://backend.example.com',
      workspaceDbKey: 'workspace-db',
      options: {
        checkoutPolicyConfig: { familySuffixes: { task: 'checkout_required' } },
      },
    }));
  });

  it('returns a request-bound SSE token to the worker without reconnecting it', () => {
    const messages = [];
    class MockWorker {
      addEventListener() {}
      removeEventListener() {}
      terminate() {}
      postMessage(message) { messages.push(message); }
    }
    globalThis.Worker = MockWorker;

    client.connectSSE('npub-owner', 'npub-viewer', 'https://backend.example.com', 'workspace-db');
    client.provideSSEToken('sse-token-9', 'connection-key', 'nip98-token');

    expect(messages).toContainEqual({
      type: 'sync-worker:sse-token',
      requestId: 'sse-token-9',
      connectionKey: 'connection-key',
      token: 'nip98-token',
    });
  });
});

describe('automatic worker recovery', () => {
  let originalWorker;

  beforeEach(() => {
    originalWorker = globalThis.Worker;
  });

  afterEach(() => {
    client.shutdownSyncWorker();
    client.setWorkerDegradedCallback(null);
    if (originalWorker === undefined) {
      delete globalThis.Worker;
    } else {
      globalThis.Worker = originalWorker;
    }
  });

  it('recovers by spawning a fresh worker after the first one crashes', async () => {
    const workerInstances = [];
    let crashFirst = true;

    class MockWorker {
      constructor() {
        workerInstances.push(this);
        this.onmessage = null;
        this.onerror = null;
        this.terminated = false;
      }
      addEventListener(type, handler) {
        if (type === 'message') this.onmessage = handler;
        if (type === 'error' || type === 'messageerror') this.onerror = handler;
      }
      removeEventListener() {}
      terminate() { this.terminated = true; }
      postMessage(message) {
        if (message.type !== 'sync-worker:request') return;
        Promise.resolve().then(() => {
          if (crashFirst) {
            crashFirst = false;
            this.onerror?.({ error: new Error('Worker crashed') });
            return;
          }
          this.onmessage?.({
            data: {
              type: 'sync-worker:response',
              id: message.id,
              ok: true,
              value: { pushed: 3, pulled: 1, pruned: 0 },
            },
          });
        });
      }
    }

    globalThis.Worker = MockWorker;

    const result = await client.runSync('npub-owner', 'npub-viewer', undefined, {
      backendUrl: 'https://backend.example.com',
    });

    expect(result).toEqual({ pushed: 3, pulled: 1, pruned: 0 });
    expect(workerInstances).toHaveLength(2);
    expect(workerInstances[0].terminated).toBe(true);
  });

  it('rejects after exhausting recovery attempts', async () => {
    let instanceCount = 0;

    class AlwaysCrashWorker {
      constructor() {
        instanceCount++;
        this.onerror = null;
      }
      addEventListener(type, handler) {
        if (type === 'error' || type === 'messageerror') this.onerror = handler;
      }
      removeEventListener() {}
      terminate() {}
      postMessage(message) {
        if (message.type !== 'sync-worker:request') return;
        Promise.resolve().then(() => {
          this.onerror?.({ error: new Error('persistent crash') });
        });
      }
    }

    globalThis.Worker = AlwaysCrashWorker;

    await expect(
      client.runSync('npub-owner', 'npub-viewer', undefined, { backendUrl: 'https://x.com' }),
    ).rejects.toThrow(/Sync worker recovery failed/);

    // 1 initial + 2 recovery = 3 worker instances created
    expect(instanceCount).toBe(3);
  });

  it('notifies the degraded callback when worker cannot recover', async () => {
    class AlwaysCrashWorker {
      constructor() { this.onerror = null; }
      addEventListener(type, handler) {
        if (type === 'error' || type === 'messageerror') this.onerror = handler;
      }
      removeEventListener() {}
      terminate() {}
      postMessage(message) {
        if (message.type !== 'sync-worker:request') return;
        Promise.resolve().then(() => {
          this.onerror?.({ error: new Error('boom') });
        });
      }
    }

    globalThis.Worker = AlwaysCrashWorker;

    const degradedEvents = [];
    client.setWorkerDegradedCallback((event) => degradedEvents.push(event));

    await expect(client.runSync('npub-owner')).rejects.toThrow();
    expect(degradedEvents.length).toBeGreaterThanOrEqual(1);
    expect(degradedEvents[degradedEvents.length - 1]).toMatchObject({
      degraded: true,
      reason: expect.any(String),
    });
  });

  it('does not fall back to local sync module when postMessage fails', async () => {
    const workerInstances = [];
    let firstPostMessage = true;

    class PostMessageFailWorker {
      constructor() {
        workerInstances.push(this);
        this.onmessage = null;
        this.onerror = null;
      }
      addEventListener(type, handler) {
        if (type === 'message') this.onmessage = handler;
        if (type === 'error' || type === 'messageerror') this.onerror = handler;
      }
      removeEventListener() {}
      terminate() {}
      postMessage(message) {
        if (message.type !== 'sync-worker:request') return;
        if (firstPostMessage) {
          firstPostMessage = false;
          throw new Error('DataCloneError');
        }
        Promise.resolve().then(() => {
          this.onmessage?.({
            data: {
              type: 'sync-worker:response',
              id: message.id,
              ok: true,
              value: { pushed: 0, pulled: 0, pruned: 0 },
            },
          });
        });
      }
    }

    globalThis.Worker = PostMessageFailWorker;

    const result = await client.runSync('npub-owner', 'npub-viewer', undefined, {
      backendUrl: 'https://backend.example.com',
    });

    expect(result).toEqual({ pushed: 0, pulled: 0, pruned: 0 });
    expect(workerInstances).toHaveLength(2);
  });
});
