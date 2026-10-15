import { afterEach, describe, expect, it, vi } from 'vitest';
import { Observable, Subject, of, NEVER } from 'rxjs';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { NostrRelayClient } from '../src/feed/nostr-relay-client.js';
import { NostrNotificationService } from '../src/feed/nostr-service.js';
import { notificationInboxRelays, notificationRelays } from '../src/nostr-relays.js';
const secret = generateSecretKey(),
  pubkey = getPublicKey(secret);
const sign = (kind, tags = [], content = '') =>
  finalizeEvent({ kind, tags, content, created_at: Math.floor(Date.now() / 1000) }, secret);
afterEach(() => vi.useRealTimers());
describe('Applesauce notification retrieval', () => {
  it('canonicalizes recipient read relays, excludes write-only entries and reserves bounded inbox fallback', () => {
    expect(notificationRelays(['wss://a.example/path/'])).toEqual(['wss://a.example/path/']);
    const event = sign(10002, [
      ['r', 'wss://inbox.example/', 'read'],
      ['r', 'wss://inbox.example'],
      ['r', 'wss://write.example', 'write'],
      ['r', 'https://bad.example'],
    ]);
    expect(notificationInboxRelays(event)).toEqual([
      'wss://inbox.example',
      'wss://relay.primal.net',
      'wss://relay.damus.io',
    ]);
    expect(
      notificationInboxRelays(
        sign(
          10002,
          Array.from({ length: 10 }, (_, i) => ['r', `wss://r${i}.example`]),
        ),
      ),
    ).toHaveLength(6);
    expect(
      notificationInboxRelays(
        sign(
          10002,
          Array.from({ length: 10 }, (_, i) => ['r', `wss://r${i}.example`]),
        ),
      ).slice(-2),
    ).toEqual(['wss://relay.primal.net', 'wss://relay.damus.io']);
    expect(
      notificationRelays(['wss://a.example/', 'wss://a.example', 'wss://user:pass@a.example']),
    ).toEqual(['wss://a.example']);
  });
  it('uses actual address/event loaders, validates before admission, caches and follows relay hints', async () => {
    vi.useFakeTimers();
    const profile = sign(0, [], '{"name":"Alice"}'),
      note = sign(1, [], 'Original');
    const pool = {
      request: vi.fn((_relays, filters) =>
        of(
          ...(filters[0]?.ids || filters.ids
            ? [note]
            : [{ ...profile, content: 'tampered' }, profile]),
        ),
      ),
      close: vi.fn(),
    };
    const client = new NostrRelayClient({ pool });
    const pendingProfile = client.query(['wss://lookup.example'], {
      kinds: [0],
      authors: [pubkey],
    });
    await vi.advanceTimersByTimeAsync(30);
    expect((await pendingProfile).map((event) => event.id)).toEqual([profile.id]);
    const pendingNote = client.query(['wss://hint.example'], { ids: [note.id] });
    await vi.advanceTimersByTimeAsync(30);
    expect(await pendingNote).toEqual([note]);
    expect(client.store.getEvent(note.id)?.id).toBe(note.id);
    expect(pool.request.mock.calls.some(([relays]) => relays.includes('wss://hint.example'))).toBe(
      true,
    );
    const calls = pool.request.mock.calls.length;
    expect(await client.query([], { ids: [note.id] })).toEqual([note]);
    expect(pool.request).toHaveBeenCalledTimes(calls);
    client.resetCache();
    expect(client.store.getEvent(note.id)).toBeUndefined();
    client.dispose();
    expect(pool.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('distinguishes per-relay EOSE from failure and times out hanging catch-up without discarding good events', async () => {
    vi.useFakeTimers();
    const stream = new Subject(),
      handlers = { onevent: vi.fn(), progress: vi.fn(), onclose: vi.fn() };
    const pool = { req: vi.fn(() => stream), close: vi.fn() };
    const client = new NostrRelayClient({ pool });
    const sub = client.subscribe(
      ['wss://good.example', 'wss://silent.example'],
      { kinds: [1] },
      handlers,
    );
    const event = sign(1);
    stream.next({ type: 'EVENT', event, from: 'wss://good.example/' });
    stream.next({
      type: 'EVENT',
      event: { ...event, content: 'tampered' },
      from: 'wss://good.example/',
    });
    stream.next({ type: 'EOSE', from: 'wss://good.example/' });
    await vi.advanceTimersByTimeAsync(8000);
    expect(handlers.onevent).toHaveBeenCalledTimes(1);
    expect(handlers.progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ completed: 1, failed: 1, settled: true }),
    );
    stream.next({ type: 'EOSE', from: 'wss://silent.example/' });
    expect(handlers.progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ completed: 2, failed: 0, settled: true }),
    );
    sub.close();
    client.dispose();
    expect(stream.observed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds never-responding lookups and aborts active loader requests at identity disposal', async () => {
    vi.useFakeTimers();
    const teardown = vi.fn();
    const pool = { request: () => new Observable(() => teardown), close: vi.fn() };
    const client = new NostrRelayClient({ pool });
    const pending = client.query(['wss://silent.example'], { ids: ['a'.repeat(64)] });
    await vi.advanceTimersByTimeAsync(4500);
    expect(await pending).toEqual([]);
    const second = client.query(['wss://silent.example'], { ids: ['b'.repeat(64)] });
    await vi.advanceTimersByTimeAsync(30);
    client.dispose();
    expect(await second).toEqual([]);
    expect(teardown).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('never reports failed transport as a successful empty feed', async () => {
    vi.useFakeTimers();
    let handlers;
    const status = vi.fn();
    const pool = {
      query: async () => [],
      subscribe: (_r, _f, h) => ((handlers = h), { close: vi.fn() }),
      dispose: vi.fn(),
    };
    const service = new NostrNotificationService({ recipient: pubkey, pool, status });
    await service.start();
    handlers.progress({ completed: 0, failed: 2, total: 2, settled: true });
    expect(status).toHaveBeenLastCalledWith(
      'Could not load Nostr notifications. Cached notifications remain; refresh to retry.',
    );
    handlers.progress({ completed: 2, failed: 0, total: 2, settled: true });
    expect(status).toHaveBeenLastCalledWith(
      'No verified public notifications in the recent 7 days.',
    );
    service.dispose();
  });
});
