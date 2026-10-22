import { finalizeEvent, getPublicKey } from 'nostr-tools';
import './setup.js';
import { afterEach, expect, it, vi } from 'vitest';
import { attachCanvasChatSigner, createCanvasChatSignerClient, validateChatSigningEvent } from '../src/canvas/chat-signer.js';

const origin = 'http://localhost';
const secret = new Uint8Array(32).fill(1);
const state = { workspaceKey: 'key', workspaceId: 'ws', pubkey: getPublicKey(secret), npub: 'npub', method: 'extension', workspaceSessionNpub: 'npub', baseUrl: 'http://tower' };
const event = () => ({ kind: 27235, pubkey: state.pubkey, content: '', created_at: Math.floor(Date.now() / 1000), tags: [['u', 'http://tower/api/v4/flightdeck-pg/workspaces/ws/channels'], ['method', 'GET']] });
function target() {
  const handlers = new Map();
  return { addEventListener: (name, fn) => { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); }, removeEventListener: (name, fn) => handlers.get(name)?.delete(fn), emit: (name, data) => Promise.all([...handlers.get(name) || []].map(fn => fn(data))) };
}
function fixture(options = {}) {
  let active = { ...state };
  const host = { ...target(), location: { origin }, nostr: {} };
  const src = origin + '/flight-deck?canvaschat=1&workspacekey=key&canvaskey=chat';
  const source = { location: { href: src }, postMessage: vi.fn() };
  const element = { ...target(), isConnected: true, src, dataset: { canvasChatFrame: 'chat' }, contentWindow: source, contentDocument: {} };
  const sign = vi.fn(async (e, opts) => { await opts.assertCurrent(); return finalizeEvent(e, secret); });
  const getPublicKey = vi.fn(async () => state.pubkey);
  const dispose = attachCanvasChatSigner({ host, element, context: () => active, signEvent: sign, getPublicKey, getSession: async () => ({ method: 'extension', pubkey: state.pubkey }), ...options });
  const message = (changes = {}, envelope = {}) => host.emit('message', { origin, source, data: { type: 'ambulando-canvas-chat-sign', id: crypto.randomUUID(), workspaceKey: 'key', pubkey: state.pubkey, key: 'chat', method: 'signEvent', event: event(), ...changes }, ...envelope });
  return { host, element, source, sign, getPublicKey, dispose, message, change: patch => { active = { ...active, ...patch }; } };
}
afterEach(() => vi.useRealTimers());
it('returns exact ordinary signed events and public keys independently for multiple registered frames', async () => {
  const a = fixture(), b = fixture();
  await Promise.all([a.message(), b.message({ method: 'getPublicKey' })]);
  expect(a.sign).toHaveBeenCalledTimes(1);
  expect(a.source.postMessage.mock.calls[0]).toEqual([expect.objectContaining({ result: expect.objectContaining({ ...event(), sig: expect.any(String), id: expect.any(String) }) }), origin]);
  expect(b.source.postMessage.mock.calls[0][0].result).toBe(state.pubkey);
  a.dispose(); b.dispose();
});
it('ignores wrong origin, wrong source and unregistered frames without touching the provider', async () => {
  const f = fixture();
  await f.message({}, { origin: 'https://evil' }); await f.message({}, { source: {} });
  expect(f.sign).not.toHaveBeenCalled(); expect(f.getPublicKey).not.toHaveBeenCalled(); expect(f.source.postMessage).not.toHaveBeenCalled();
  f.element.contentWindow.location.href = origin + '/artifact.html'; await f.message();
  expect(f.sign).not.toHaveBeenCalled(); expect(f.source.postMessage.mock.calls[0][0].error).toBeTruthy(); f.dispose();
});
it('denies unsupported operations, kinds, remote targets and mismatched workspace/session', async () => {
  const f = fixture();
  for (const patch of [{ method: 'decrypt' }, { event: { ...event(), kind: 1 } }, { workspaceKey: 'other' }, { pubkey: 'other' }, { key: 'other' }, { event: { ...event(), tags: [['u', 'https://evil/api/test'], ['method', 'POST']] } }]) await f.message(patch);
  expect(f.sign).not.toHaveBeenCalled(); expect(f.source.postMessage.mock.calls.every(([reply]) => reply.error)).toBe(true);
  f.change({ workspaceSessionNpub: 'other' }); await f.message(); expect(f.sign).not.toHaveBeenCalled(); f.dispose();
});
it('rejects workspace, provider and document identity drift during signing, discarding late results', async () => {
  for (const drift of [f => f.change({ pubkey: 'other' }), f => { f.host.nostr = {}; }, f => { f.element.contentDocument = {}; }]) {
    let finish;
    const f = fixture({ signEvent: e => new Promise(resolve => { finish = () => resolve(e); }) });
    const job = f.message(); await vi.waitFor(() => expect(finish).toBeTruthy()); drift(f); finish(); await job;
    expect(f.source.postMessage.mock.calls[0][0].error).toBeTruthy();
    await f.message(); expect(f.source.postMessage.mock.calls.at(-1)[0].error).toBeTruthy(); f.dispose();
  }
});
it('rejects persisted logout or live public-key drift before invoking the signer', async () => {
  for (const options of [{ getSession: async () => null }, { getPublicKey: async () => 'other' }]) {
    const f = fixture(options); await f.message(); expect(f.sign).not.toHaveBeenCalled(); expect(f.source.postMessage.mock.calls[0][0].error).toBeTruthy(); f.dispose();
  }
});
it('bounds pending work, ignores duplicate IDs, times out once and guards queued work after expiry', async () => {
  vi.useFakeTimers(); let guard;
  const f = fixture({ timeoutMs: 50, signEvent: (_e, opts) => { guard = opts.assertCurrent; return new Promise(() => {}); } });
  void f.message({ id: 'same' }); await vi.advanceTimersByTimeAsync(1);
  await f.message({ id: 'same' }); expect(f.source.postMessage).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(50);
  expect(f.source.postMessage).toHaveBeenCalledTimes(1); expect(() => guard()).toThrow('expired'); f.dispose();
});
it('propagates rejection and teardown without returning a late signed result', async () => {
  const rejected = fixture({ signEvent: async () => { throw new Error('User rejected'); } });
  await rejected.message(); expect(rejected.source.postMessage.mock.calls[0][0].error.message).toBe('User rejected'); rejected.dispose();
  let finish, guard;
  const f = fixture({ signEvent: (e, opts) => new Promise(resolve => { guard = opts.assertCurrent; finish = () => resolve(e); }) });
  const job = f.message(); await vi.waitFor(() => expect(finish).toBeTruthy()); f.dispose(); expect(() => guard()).toThrow('closed'); finish(); await job;
  expect(f.source.postMessage).toHaveBeenCalledTimes(1);
});
it('accepts scoped message instructions and denies other workspaces without mutating payloads', () => {
  const e = { ...event(), kind: 33358, content: 'Hello', tags: [['protocol', 'flightdeck_pg_message_instruction'], ['workspace_id', 'ws']] };
  const before = JSON.stringify(e); validateChatSigningEvent(e, state); expect(JSON.stringify(e)).toBe(before);
  expect(() => validateChatSigningEvent({ ...e, tags: [['protocol', 'flightdeck_pg_message_instruction'], ['workspace_id', 'other']] }, state)).toThrow();
});
it('client correlates only same-origin parent replies and rejects bounded timeout/disposal', async () => {
  vi.useFakeTimers();
  const parent = { postMessage: vi.fn() }, host = { ...target(), location: { origin }, parent };
  const client = createCanvasChatSignerClient({ host, workspaceKey: 'key', pubkey: state.pubkey, key: 'chat', timeoutMs: 50 });
  const promise = client.bridge.getPublicKey();
  const id = parent.postMessage.mock.calls[0][0].id;
  await host.emit('message', { origin: 'https://evil', source: parent, data: { type: 'ambulando-canvas-chat-signed', id, result: 'wrong' } });
  await host.emit('message', { origin, source: {}, data: { type: 'ambulando-canvas-chat-signed', id, result: 'wrong' } });
  await host.emit('message', { origin, source: parent, data: { type: 'ambulando-canvas-chat-signed', id: 'other', result: 'wrong' } });
  await host.emit('message', { origin, source: parent, data: { type: 'ambulando-canvas-chat-signed', id, result: state.pubkey } });
  expect(await promise).toBe(state.pubkey);
  const timed = expect(client.bridge.getPublicKey()).rejects.toThrow('timed out'); await vi.advanceTimersByTimeAsync(51); await timed;
  const disposed = expect(client.bridge.signEvent(event())).rejects.toThrow('closed'); client.dispose(); await disposed;
});

it('preserves the initial load even if startup signing precedes load, then revokes navigation', async () => {
  const f = fixture(); await f.message({ method: 'getPublicKey' });
  await f.element.emit('load'); await f.message(); expect(f.sign).toHaveBeenCalledTimes(1);
  await f.element.emit('load'); await f.message(); expect(f.sign).toHaveBeenCalledTimes(1);
  expect(f.source.postMessage.mock.calls.at(-1)[0].error).toBeTruthy(); f.dispose();
});
it('rejects altered timestamps, invalid signatures and signed payload mutation', async () => {
  for (const alter of [e => ({ ...finalizeEvent(e, secret), created_at: e.created_at + 100 }),
    e => ({ ...finalizeEvent(e, secret), sig: '0'.repeat(128) }),
    e => { e.tags.push(['extra', 'unexpected']); return finalizeEvent(e, secret); }]) {
    const f = fixture({ signEvent: async e => alter(e) }); await f.message();
    expect(f.source.postMessage.mock.calls[0][0].error).toBeTruthy(); f.dispose();
  }
});
it('limits concurrent requests and frees capacity after deadlines', async () => {
  vi.useFakeTimers();
  const f = fixture({ getPublicKey: () => new Promise(() => {}), timeoutMs: 50 });
  for (let i = 0; i < 8; i++) void f.message({ id: `request-${i}` });
  await f.message({ id: 'overflow' });
  expect(f.source.postMessage.mock.calls[0][0].error.message).toContain('Too many');
  await vi.advanceTimersByTimeAsync(51);
  expect(f.source.postMessage).toHaveBeenCalledTimes(9); f.dispose();
});
it('denies administrative targets and bare or encoded other-workspace endpoints', () => {
  for (const [path, method] of [['/api/v4/admin/flightdeck-pg/workspaces', 'POST'], ['/api/v4/groups', 'GET'],
    ['/api/v4/flightdeck-pg/workspaces/other', 'GET'], ['/api/v4/flightdeck-pg/workspaces/ws-extra/channels', 'GET'],
    ['/api/v4/flightdeck-pg/workspaces/ws/members', 'POST'], ['/api/v4/flightdeck-pg/workspaces/ws', 'DELETE'],
    ['/api/v4/flightdeck-pg/workspaces/ws/../other/channels', 'GET']]) {
    expect(() => validateChatSigningEvent({ ...event(), tags: [['u', `http://tower${path}`], ['method', method]] }, state)).toThrow('Unsupported');
  }
  validateChatSigningEvent({ ...event(), tags: [['u', 'http://tower/api/v4/flightdeck-pg/workspaces/ws'], ['method', 'GET']] }, state);
});

it('cleans up when removal destroys the browsing context during a native prompt', async () => {
  let finish;
  const f = fixture({ signEvent: e => new Promise(resolve => { finish = () => resolve(finalizeEvent(e, secret)); }) });
  const job = f.message(); await vi.waitFor(() => expect(finish).toBeTruthy());
  f.element.contentWindow = null; f.element.isConnected = false;
  expect(() => f.dispose()).not.toThrow(); finish(); await job;
  expect(f.source.postMessage).not.toHaveBeenCalled();
});
