import { nip19 } from 'nostr-tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setExtensionSignerBridge } from '../src/auth/nostr.js';
import { getSyncState, setSyncState } from '../src/db.js';

vi.mock('../src/worker/sync-worker.js', () => ({
  runSync: vi.fn(),
  flushPendingWrites: vi.fn(async () => ({ pushed: 0 })),
  pullRecordsForFamilies: vi.fn(async () => ({})),
  pruneOnLogin: vi.fn(),
  checkStaleness: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getPendingWrites: vi.fn(async () => []),
  getSyncState: vi.fn(async () => null),
  openWorkspaceDb: vi.fn(),
  setSyncState: vi.fn(async () => 1),
}));
vi.mock('../src/api.js', () => ({ setBaseUrl: vi.fn() }));
vi.mock('../src/auth/nostr.js', () => ({ setExtensionSignerBridge: vi.fn() }));
vi.mock('../src/crypto/group-keys.js', () => ({
  importDecryptedKeys: vi.fn(),
  setActiveSessionNpub: vi.fn(),
}));
vi.mock('../src/crypto/workspace-keys.js', () => ({ importWorkspaceKeyFromMain: vi.fn() }));

class MockEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.closed = false;
    MockEventSource.instances.push(this);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  emit(type, event = {}) {
    this.listeners.get(type)?.(event);
  }

  close() {
    this.closed = true;
  }
}

describe('sync worker SSE handshake integration', () => {
  let posted;
  let dispatch;
  let originalSelf;
  let originalEventSource;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    getSyncState.mockResolvedValue(null);
    setSyncState.mockResolvedValue(1);
    vi.resetModules();
    posted = [];
    originalSelf = globalThis.self;
    originalEventSource = globalThis.EventSource;
    globalThis.self = {
      addEventListener(type, listener) {
        if (type === 'message') dispatch = (data) => listener({ data });
      },
      postMessage(message) {
        posted.push(message);
      },
    };
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource;
    await import('../src/worker/sync-worker-runner.js');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
    if (originalEventSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = originalEventSource;
  });

  function latestStatus(status) {
    return posted.filter((message) => message.type === 'sync-worker:sse-status' && message.status === status).at(-1);
  }

  async function flushAsyncConnect() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  function workspaceCursorFallback(overrides = {}) {
    return {
      cursor: 'workspace-cursor-20420',
      backendOrigin: 'https://tower.example.com',
      workspaceId: 'workspace-1',
      ownerNpub: 'npub1owner',
      viewerNpub: 'npub1viewer',
      workspaceDbKey: 'workspace-db',
      ...overrides,
    };
  }

  it('settles rejected worker signer calls with their native recovery code', async () => {
    const bridge = setExtensionSignerBridge.mock.calls.at(-1)[0];
    const request = bridge.getPublicKey();
    const assertion = expect(request).rejects.toMatchObject({ message: 'Browser signing paused', code: 'native_signer_document_revoked' });
    const auth = posted.find(message => message.type === 'sync-worker:auth-request');
    dispatch({ type: 'sync-worker:auth-response', authId: auth.authId, ok: false, error: { message: 'Browser signing paused', code: 'native_signer_document_revoked' } });
    await assertion;
    const recovered = bridge.getPublicKey();
    const next = posted.filter(message => message.type === 'sync-worker:auth-request').at(-1);
    dispatch({ type: 'sync-worker:auth-response', authId: next.authId, ok: true, value: 'restored-public-key' });
    await expect(recovered).resolves.toBe('restored-public-key');
  });

  it('runs native SSE under the existing worker and recovers only its committed logical-workspace cursor', async () => {
    const endpoint = `http://${nip19.npubEncode('12'.repeat(32))}.fips:41080`;
    const streams = [];
    const nativeFetch = vi.fn(async () => new Response(new ReadableStream({ start(controller) { streams.push(controller); } }), { headers: { 'content-type': 'text/event-stream' } }));
    dispatch({ type: 'sync-worker:bootstrap-keys', towerTransports: [{
      logicalTower: 'https://tower.example.com', mode: 'fips', transport: 'native', endpoint,
      handle: { fetch: nativeFetch },
    }] });
    dispatch({
      type: 'sync-worker:sse-connect', ownerNpub: 'npub1owner', viewerNpub: 'npub1viewer',
      backendUrl: 'https://tower.example.com', workspaceDbKey: 'workspace-db',
      options: { pgMode: true, workspaceId: 'workspace-1' },
    });
    await flushAsyncConnect();
    const initial = latestStatus('token-needed');
    dispatch({ type: 'sync-worker:sse-token', requestId: initial.requestId, connectionKey: initial.connectionKey, token: 'signed-mesh-token' });
    await vi.advanceTimersByTimeAsync(0);
    expect(MockEventSource.instances).toHaveLength(0);
    expect(nativeFetch.mock.calls[0][0]).toBe(`${endpoint}/api/v4/flightdeck-pg/workspaces/workspace-1/events/stream?token=signed-mesh-token`);
    streams[0].enqueue(new TextEncoder().encode('event: flightdeck_pg.event\ndata: {"cursor":"committed-7","entity_type":"task","entity_id":"task-1"}\n\n'));
    await vi.advanceTimersByTimeAsync(301);
    const batch = latestStatus('pull-complete');
    expect(batch.pgEvents[0].entity_id).toBe('task-1');
    dispatch({ type: 'sync-worker:sse-ack', batchId: batch.batchId, connectionKey: batch.connectionKey, connectionGeneration: batch.connectionGeneration });
    await flushAsyncConnect();
    expect(setSyncState).toHaveBeenCalledWith(expect.stringContaining('sse_pg_ack_cursor:v1'), 'committed-7');
    expect(batch.connectionKey).toContain('https://tower.example.com');
    expect(batch.connectionKey).not.toContain('.fips');
    streams[0].error(new Error('mesh disconnected'));
    await vi.advanceTimersByTimeAsync(1000);
    const recovery = latestStatus('token-needed');
    expect(recovery.requestId).not.toBe(initial.requestId);
    expect(recovery.signingUrl).toContain('cursor=committed-7');
    dispatch({ type: 'sync-worker:sse-token', requestId: recovery.requestId, connectionKey: recovery.connectionKey, token: 'fresh-mesh-token' });
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeFetch.mock.calls[1][0]).toContain(`${endpoint}/api/`);
    expect(nativeFetch.mock.calls[1][0]).toContain('cursor=committed-7&token=fresh-mesh-token');
    dispatch({ type: 'sync-worker:sse-disconnect' });
    streams[1].close();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('seeds a missing acknowledgement cursor from the exact workspace materialisation context', async () => {
    dispatch({
      type: 'sync-worker:sse-connect', ownerNpub: 'npub1owner', viewerNpub: 'npub1viewer',
      backendUrl: 'https://tower.example.com/path', workspaceDbKey: 'workspace-db',
      options: {
        pgMode: true,
        workspaceId: 'workspace-1',
        workspaceCursorFallback: workspaceCursorFallback(),
      },
    });
    await flushAsyncConnect();

    expect(latestStatus('token-needed').signingUrl).toBe(
      'https://tower.example.com/api/v4/flightdeck-pg/workspaces/workspace-1/events/stream?cursor=workspace-cursor-20420',
    );
  });

  it('prefers a present durable acknowledgement cursor over the workspace cursor', async () => {
    getSyncState.mockResolvedValueOnce('acknowledged-cursor-20425');
    dispatch({
      type: 'sync-worker:sse-connect', ownerNpub: 'npub1owner', viewerNpub: 'npub1viewer',
      backendUrl: 'https://tower.example.com', workspaceDbKey: 'workspace-db',
      options: {
        pgMode: true,
        workspaceId: 'workspace-1',
        workspaceCursorFallback: workspaceCursorFallback(),
      },
    });
    await flushAsyncConnect();

    expect(latestStatus('token-needed').signingUrl).toContain('cursor=acknowledged-cursor-20425');
    expect(latestStatus('token-needed').signingUrl).not.toContain('workspace-cursor-20420');
  });

  it.each([
    ['backend', { backendOrigin: 'https://other-tower.example.com' }],
    ['workspace', { workspaceId: 'workspace-2' }],
    ['owner', { ownerNpub: 'npub1other' }],
    ['viewer', { viewerNpub: 'npub1other' }],
  ])('does not seed a cursor across a %s context mismatch', async (_label, mismatch) => {
    dispatch({
      type: 'sync-worker:sse-connect', ownerNpub: 'npub1owner', viewerNpub: 'npub1viewer',
      backendUrl: 'https://tower.example.com', workspaceDbKey: 'workspace-db',
      options: {
        pgMode: true,
        workspaceId: 'workspace-1',
        workspaceCursorFallback: workspaceCursorFallback(mismatch),
      },
    });
    await flushAsyncConnect();

    expect(latestStatus('token-needed').signingUrl).toBe(
      'https://tower.example.com/api/v4/flightdeck-pg/workspaces/workspace-1/events/stream',
    );
  });

  it('skips a simulated 20k replay backlog and reaches the next live event in one stream batch', async () => {
    dispatch({
      type: 'sync-worker:sse-connect', ownerNpub: 'npub1owner', viewerNpub: 'npub1viewer',
      backendUrl: 'https://tower.example.com', workspaceDbKey: 'workspace-db',
      options: {
        pgMode: true,
        workspaceId: 'workspace-1',
        workspaceCursorFallback: workspaceCursorFallback(),
      },
    });
    await flushAsyncConnect();
    const request = latestStatus('token-needed');
    dispatch({
      type: 'sync-worker:sse-token', requestId: request.requestId,
      connectionKey: request.connectionKey, token: 'token',
    });
    MockEventSource.instances[0].emit('flightdeck_pg.event', {
      data: JSON.stringify({ cursor: 'workspace-cursor-20421', entity_type: 'message', entity_id: 'live-message' }),
    });
    await vi.advanceTimersByTimeAsync(300);

    const batches = posted.filter((message) => message.status === 'pull-complete');
    expect(batches).toHaveLength(1);
    expect(batches[0].pgEvents).toEqual([expect.objectContaining({ entity_id: 'live-message' })]);
  });

  it('signs the newest legacy event id again on reconnect before adding token', () => {
    dispatch({
      type: 'sync-worker:sse-connect',
      ownerNpub: 'npub1owner',
      viewerNpub: 'npub1viewer',
      backendUrl: 'https://tower.example.com',
      workspaceDbKey: 'workspace-db',
      options: {},
    });
    const initial = latestStatus('token-needed');
    expect(initial.signingUrl).toBe('https://tower.example.com/api/v4/workspaces/npub1owner/stream');
    expect(MockEventSource.instances).toHaveLength(0);

    dispatch({
      type: 'sync-worker:sse-token',
      requestId: initial.requestId,
      connectionKey: initial.connectionKey,
      token: 'initial token',
    });
    const firstSource = MockEventSource.instances[0];
    expect(firstSource.url).toBe(`${initial.signingUrl}?token=initial+token`);
    firstSource.emit('connected', { lastEventId: 'event 42/next', data: '{}' });
    firstSource.readyState = 2;
    firstSource.onerror();
    expect(latestStatus('reconnecting').delayMs).toBe(0);
    vi.advanceTimersByTime(0);
    const reconnect = latestStatus('token-needed');
    expect(reconnect.requestId).not.toBe(initial.requestId);
    expect(reconnect.signingUrl).toBe(
      'https://tower.example.com/api/v4/workspaces/npub1owner/stream?last_event_id=event+42%2Fnext',
    );
    expect(reconnect.signingUrl).not.toContain('token=');

    dispatch({
      type: 'sync-worker:sse-token',
      requestId: reconnect.requestId,
      connectionKey: reconnect.connectionKey,
      token: 'reconnect token',
    });
    expect(MockEventSource.instances[1].url).toBe(`${reconnect.signingUrl}&token=reconnect+token`);
  });

  it('signs only the acknowledged PG cursor again on reconnect', async () => {
    dispatch({
      type: 'sync-worker:sse-connect',
      ownerNpub: 'npub1owner',
      viewerNpub: 'npub1viewer',
      backendUrl: 'https://tower.example.com',
      workspaceDbKey: 'workspace-db',
      options: { pgMode: true, workspaceId: 'workspace-1' },
    });
    await flushAsyncConnect();
    const initial = latestStatus('token-needed');
    dispatch({
      type: 'sync-worker:sse-token', requestId: initial.requestId,
      connectionKey: initial.connectionKey, token: 'initial-token',
    });
    const source = MockEventSource.instances[0];
    source.emit('connected', { data: JSON.stringify({ cursor: 'opaque cursor/7' }) });
    source.emit('flightdeck_pg.event', { data: JSON.stringify({ cursor: 'opaque cursor/7', entity_type: 'agent_activity', entity_id: 'row-1' }) });
    await vi.advanceTimersByTimeAsync(300);
    const batch = latestStatus('pull-complete');
    dispatch({
      type: 'sync-worker:sse-ack',
      batchId: batch.batchId,
      connectionKey: batch.connectionKey,
      connectionGeneration: batch.connectionGeneration,
      requestedCursor: batch.requestedCursor,
    });
    await flushAsyncConnect();
    expect(setSyncState).toHaveBeenCalledWith(
      'sse_pg_ack_cursor:v1:https%3A%2F%2Ftower.example.com:workspace-1:npub1owner:npub1viewer',
      'opaque cursor/7',
    );
    source.readyState = 2;
    source.onerror();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(latestStatus('token-needed').signingUrl).toBe(
      'https://tower.example.com/api/v4/flightdeck-pg/workspaces/workspace-1/events/stream?cursor=opaque+cursor%2F7',
    );
  });

  it('preserves an event received before disconnect and replays from the last committed cursor after failed materialisation', async () => {
    dispatch({
      type: 'sync-worker:sse-connect', ownerNpub: 'npub1owner', viewerNpub: 'npub1viewer',
      backendUrl: 'https://tower.example.com', workspaceDbKey: 'workspace-db',
      options: { pgMode: true, workspaceId: 'workspace-1' },
    });
    await flushAsyncConnect();
    const initial = latestStatus('token-needed');
    dispatch({ type: 'sync-worker:sse-token', requestId: initial.requestId, connectionKey: initial.connectionKey, token: 'initial' });
    const source = MockEventSource.instances[0];
    source.emit('flightdeck_pg.event', {
      data: JSON.stringify({ cursor: 'cursor-uncommitted', entity_type: 'agent_activity', entity_id: 'row-1' }),
    });
    source.readyState = 2;
    source.onerror();

    await vi.advanceTimersByTimeAsync(300);
    expect(latestStatus('pull-complete')).toMatchObject({
      receivedCursor: 'cursor-uncommitted',
      acknowledgedCursor: null,
      pgEvents: [expect.objectContaining({ entity_id: 'row-1' })],
    });
    await vi.advanceTimersByTimeAsync(700);
    expect(latestStatus('token-needed').signingUrl).toBe(
      'https://tower.example.com/api/v4/flightdeck-pg/workspaces/workspace-1/events/stream',
    );
  });

  it('accepts a committed same-context batch after reconnect and advances its cursor exactly once', async () => {
    dispatch({
      type: 'sync-worker:sse-connect', ownerNpub: 'npub1owner', viewerNpub: 'npub1viewer',
      backendUrl: 'https://tower.example.com', workspaceDbKey: 'workspace-db',
      options: { pgMode: true, workspaceId: 'workspace-1' },
    });
    await flushAsyncConnect();
    const initial = latestStatus('token-needed');
    dispatch({ type: 'sync-worker:sse-token', requestId: initial.requestId, connectionKey: initial.connectionKey, token: 'initial' });
    const source = MockEventSource.instances[0];
    source.emit('flightdeck_pg.event', {
      data: JSON.stringify({ cursor: 'cursor-after-commit', entity_type: 'agent_activity', entity_id: 'row-1' }),
    });
    await vi.advanceTimersByTimeAsync(300);
    const batch = latestStatus('pull-complete');
    source.readyState = 2;
    source.onerror();
    await vi.advanceTimersByTimeAsync(1_000);
    const reconnect = latestStatus('token-needed');
    dispatch({ type: 'sync-worker:sse-token', requestId: reconnect.requestId, connectionKey: reconnect.connectionKey, token: 'reconnect' });

    const acknowledgement = {
      type: 'sync-worker:sse-ack',
      batchId: batch.batchId,
      connectionKey: batch.connectionKey,
      connectionGeneration: batch.connectionGeneration,
    };
    dispatch(acknowledgement);
    await flushAsyncConnect();
    dispatch(acknowledgement);
    await flushAsyncConnect();

    expect(setSyncState).toHaveBeenCalledTimes(1);
    expect(setSyncState).toHaveBeenCalledWith(expect.stringContaining('sse_pg_ack_cursor:v1'), 'cursor-after-commit');
  });

  it('does not advance past an earlier uncommitted batch when a later batch commits first', async () => {
    dispatch({
      type: 'sync-worker:sse-connect', ownerNpub: 'npub1owner', viewerNpub: 'npub1viewer',
      backendUrl: 'https://tower.example.com', workspaceDbKey: 'workspace-db',
      options: { pgMode: true, workspaceId: 'workspace-1' },
    });
    await flushAsyncConnect();
    const request = latestStatus('token-needed');
    dispatch({ type: 'sync-worker:sse-token', requestId: request.requestId, connectionKey: request.connectionKey, token: 'token' });
    const source = MockEventSource.instances[0];
    source.emit('flightdeck_pg.event', { data: JSON.stringify({ cursor: 'cursor-1', entity_type: 'task', entity_id: 'bad' }) });
    await vi.advanceTimersByTimeAsync(300);
    source.emit('flightdeck_pg.event', { data: JSON.stringify({ cursor: 'cursor-2', entity_type: 'task', entity_id: 'good' }) });
    await vi.advanceTimersByTimeAsync(300);
    const batches = posted.filter((message) => message.status === 'pull-complete');

    dispatch({
      type: 'sync-worker:sse-ack', batchId: batches[1].batchId,
      connectionKey: batches[1].connectionKey, connectionGeneration: batches[1].connectionGeneration,
    });
    await flushAsyncConnect();
    expect(setSyncState).not.toHaveBeenCalled();

    dispatch({
      type: 'sync-worker:sse-ack', batchId: batches[0].batchId,
      connectionKey: batches[0].connectionKey, connectionGeneration: batches[0].connectionGeneration,
    });
    await flushAsyncConnect();
    expect(setSyncState).toHaveBeenCalledTimes(1);
    expect(setSyncState).toHaveBeenCalledWith(expect.stringContaining('sse_pg_ack_cursor:v1'), 'cursor-2');
  });

  it('times out and retries a missing signing response, and retries an explicit failure', async () => {
    dispatch({
      type: 'sync-worker:sse-connect', ownerNpub: 'npub1owner', viewerNpub: 'npub1viewer',
      backendUrl: 'https://tower.example.com', workspaceDbKey: 'workspace-db', options: {},
    });
    const first = latestStatus('token-needed');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(latestStatus('token-failed')).toMatchObject({ reason: 'token-request-timeout' });
    await vi.advanceTimersByTimeAsync(1_000);
    const retry = latestStatus('token-needed');
    expect(retry.requestId).not.toBe(first.requestId);

    dispatch({
      type: 'sync-worker:sse-token', requestId: retry.requestId,
      connectionKey: retry.connectionKey, ok: false, errorCode: 'signer-rejected',
    });
    expect(latestStatus('token-failed')).toMatchObject({ reason: 'token-request-failed' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(latestStatus('token-needed').requestId).not.toBe(retry.requestId);
  });

  it('discards stale and duplicate token responses across a context switch', () => {
    dispatch({
      type: 'sync-worker:sse-connect', ownerNpub: 'owner-1', viewerNpub: 'viewer',
      backendUrl: 'https://tower.example.com', workspaceDbKey: 'workspace-1', options: {},
    });
    const old = latestStatus('token-needed');
    dispatch({
      type: 'sync-worker:sse-connect', ownerNpub: 'owner-2', viewerNpub: 'viewer',
      backendUrl: 'https://tower.example.com', workspaceDbKey: 'workspace-2', options: {},
    });
    const current = latestStatus('token-needed');

    dispatch({ type: 'sync-worker:sse-token', requestId: old.requestId, connectionKey: old.connectionKey, token: 'stale' });
    expect(MockEventSource.instances).toHaveLength(0);
    dispatch({ type: 'sync-worker:sse-token', requestId: current.requestId, connectionKey: current.connectionKey, token: 'current' });
    expect(MockEventSource.instances).toHaveLength(1);
    dispatch({ type: 'sync-worker:sse-token', requestId: current.requestId, connectionKey: current.connectionKey, token: 'duplicate' });
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('discards a pending token after disconnect', () => {
    dispatch({
      type: 'sync-worker:sse-connect', ownerNpub: 'owner-1', viewerNpub: 'viewer',
      backendUrl: 'https://tower.example.com', workspaceDbKey: 'workspace-1', options: {},
    });
    const pending = latestStatus('token-needed');
    dispatch({ type: 'sync-worker:sse-disconnect', options: { reason: 'workspace-switch' } });
    dispatch({
      type: 'sync-worker:sse-token', requestId: pending.requestId,
      connectionKey: pending.connectionKey, token: 'stale',
    });
    expect(MockEventSource.instances).toHaveLength(0);
  });
});
