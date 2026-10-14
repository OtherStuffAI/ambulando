import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { normalizeNostrNotification, zapInvoice } from '../src/feed/nostr-normalize.js';
import { NostrNotificationService, zapProviderUrl } from '../src/feed/nostr-service.js';
import { persistNostrNotification, nostrNotificationsMixin } from '../src/feed/nostr-manager.js';
import { subscribedReaderMixin } from '../src/feed/reader-manager.js';
const humanKey = generateSecretKey(),
  senderKey = generateSecretKey(),
  providerKey = generateSecretKey();
const human = getPublicKey(humanKey),
  sender = getPublicKey(senderKey),
  provider = getPublicKey(providerKey);
const sign = (kind, tags = [], content = '', key = senderKey) =>
  finalizeEvent({ kind, tags, content, created_at: Math.floor(Date.now() / 1000) }, key);
const own = sign(1, [], 'My original note', humanKey);
const deps = {
  getEvent: async (id) => (id === own.id ? own : null),
  getZapProvider: async () => provider,
};
function invoice(description) {
  const words = Array(7).fill(0);
  for (const [type, data] of [
    [1, new Uint8Array(32).fill(1)],
    [16, new Uint8Array(32).fill(2)],
    [23, sha256(new TextEncoder().encode(description))],
  ]) {
    const field = bech32.toWords(data);
    words.push(type, field.length >> 5, field.length & 31, ...field);
  }
  const packed = [];
  let accumulator = 0,
    bits = 0;
  for (const word of words) {
    accumulator = (accumulator << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      packed.push((accumulator >>> bits) & 255);
    }
  }
  if (bits) packed.push((accumulator << (8 - bits)) & 255);
  const hash = sha256(new Uint8Array([...new TextEncoder().encode('lnbc10n'), ...packed]));
  const sig = secp256k1.sign(hash, providerKey, { prehash: false, format: 'recovered' });
  return bech32.encode(
    'lnbc10n',
    [...words, ...bech32.toWords(new Uint8Array([...sig.slice(1), sig[0]]))],
    8192,
  );
}
function receipt(
  request = sign(
    9734,
    [
      ['p', human],
      ['amount', '1000'],
      ['relays', 'wss://nos.lol'],
    ],
    'Thanks',
  ),
) {
  const description = JSON.stringify(request);
  return sign(
    9735,
    [
      ...request.tags.filter((t) => ['p', 'e', 'a'].includes(t[0])),
      ['P', request.pubkey],
      ['description', description],
      ['bolt11', invoice(description)],
    ],
    '',
    providerKey,
  );
}
afterEach(() => vi.useRealTimers());
describe('public Nostr notification validation', () => {
  it('accepts signed mentions and verified replies; rejects DM, self, invalid and unrelated activity', async () => {
    expect(
      (
        await normalizeNostrNotification(
          sign(1, [['p', human]], '<img onerror=bad>hello'),
          human,
          deps,
        )
      ).type,
    ).toBe('Mention');
    expect(
      (
        await normalizeNostrNotification(
          sign(
            1,
            [
              ['p', human],
              ['e', own.id, '', 'reply'],
            ],
            'Reply',
          ),
          human,
          deps,
        )
      ).type,
    ).toBe('Reply');
    for (const event of [
      sign(4, [['p', human]]),
      sign(1, [['p', human]], '', humanKey),
      sign(1, [['p', sender]]),
      { ...sign(1, [['p', human]]), content: 'tampered' },
      sign(9734, [['p', human]]),
    ])
      expect(await normalizeNostrNotification(event, human, deps)).toBeNull();
  });
  it('requires final reaction recipient and verified target ownership; validates repost context', async () => {
    expect(
      (
        await normalizeNostrNotification(
          sign(
            7,
            [
              ['e', own.id],
              ['p', human],
            ],
            '♥',
          ),
          human,
          deps,
        )
      ).text,
    ).toContain(own.content);
    expect(
      await normalizeNostrNotification(
        sign(
          7,
          [
            ['e', own.id],
            ['p', human],
            ['p', sender],
          ],
          '+',
        ),
        human,
        deps,
      ),
    ).toBeNull();
    expect(
      await normalizeNostrNotification(
        sign(
          7,
          [
            ['e', 'f'.repeat(64)],
            ['p', human],
          ],
          '+',
        ),
        human,
        deps,
      ),
    ).toBeNull();
    expect(
      (
        await normalizeNostrNotification(
          sign(
            6,
            [
              ['e', own.id],
              ['p', human],
            ],
            JSON.stringify(own),
          ),
          human,
          deps,
        )
      ).type,
    ).toBe('Repost');
    expect(
      await normalizeNostrNotification(
        sign(
          6,
          [
            ['e', own.id],
            ['p', human],
          ],
          '{bad',
        ),
        human,
        deps,
      ),
    ).toBeNull();
    expect(
      (
        await normalizeNostrNotification(
          sign(16, [
            ['e', own.id],
            ['p', human],
            ['k', '1'],
          ]),
          human,
          deps,
        )
      ).type,
    ).toBe('Repost');
  });
  it('checks zap provider, invoice commitment, amount, request recipient and sender', async () => {
    const good = receipt();
    const result = await normalizeNostrNotification(good, human, deps);
    expect(result).toMatchObject({
      type: 'Zap',
      amount: 1000,
      actorNpub: nip19.npubEncode(sender),
    });
    expect(
      await normalizeNostrNotification(good, human, {
        ...deps,
        getZapProvider: async () => sender,
      }),
    ).toBeNull();
    expect(zapInvoice(good.tags.find((t) => t[0] === 'bolt11')[1], 'wrong description')).toBeNull();
    for (const request of [
      sign(9734, [
        ['p', human],
        ['p', sender],
        ['relays', 'wss://nos.lol'],
      ]),
      sign(9734, [
        ['p', human],
        ['amount', '2000'],
        ['relays', 'wss://nos.lol'],
      ]),
      sign(
        9734,
        [
          ['p', human],
          ['relays', 'wss://nos.lol'],
        ],
        '',
        humanKey,
      ),
    ])
      expect(await normalizeNostrNotification(receipt(request), human, deps)).toBeNull();
  });
  it('only resolves public HTTPS provider metadata', () => {
    expect(zapProviderUrl({ lud16: 'person@example.com' })).toBe(
      'https://example.com/.well-known/lnurlp/person',
    );
    for (const lud16 of [
      'a@localhost',
      'a@127.0.0.1',
      'a@10.0.0.1',
      'a@example.local',
      'a@example.com:443',
      'bad',
    ])
      expect(zapProviderUrl({ lud16 })).toBeNull();
  });
});
it('deduplicates multi-relay delivery, bounds work and closes subscriptions', async () => {
  vi.useFakeTimers();
  let handlers;
  const close = vi.fn(),
    emit = vi.fn();
  const pool = {
    querySync: vi.fn(async () => []),
    subscribeMany: vi.fn((_r, _f, h) => {
      handlers = h;
      return { close };
    }),
    close: vi.fn(),
    destroy: vi.fn(),
  };
  const service = new NostrNotificationService({ recipient: human, pool, emit });
  await service.start();
  const event = sign(1, [['p', human]], 'Hello');
  handlers.onevent(event);
  handlers.onevent(event);
  await vi.advanceTimersByTimeAsync(0);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(pool.subscribeMany.mock.calls[0][1]).toMatchObject({
    limit: 200,
    kinds: [1, 6, 7, 16, 9735],
  });
  const late = sign(1, [['p', human]], 'late');
  handlers.onevent(late);
  service.dispose();
  await Promise.resolve();
  expect(emit).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalled();
  expect(pool.destroy).toHaveBeenCalled();
});
it('upserts without losing flags; isolates identity and rejects late writes', async () => {
  const db = new Dexie(`nostr-test-${crypto.randomUUID()}`);
  db.version(1).stores({
    nostr_notifications: '&key, context, id',
    nostr_notification_states: '&key, context',
  });
  try {
    const row = await normalizeNostrNotification(sign(1, [['p', human]], 'Hello'), human, deps);
    await persistNostrNotification(db, 'human', row);
    const key = JSON.stringify(['human', row.id]);
    await db.nostr_notification_states.put({ key, context: 'human', read: true, saved: true });
    await persistNostrNotification(db, 'human', row);
    expect(await db.nostr_notifications.count()).toBe(1);
    expect(await db.nostr_notifications.get(key)).toMatchObject({ read: true, saved: true });
    await persistNostrNotification(db, 'other', row, () => false);
    expect(await db.nostr_notifications.where('context').equals('other').count()).toBe(0);
    const store = {
      currentWorkspaceKey: 'w',
      session: { npub: 'new' },
      nostrNotificationContext: JSON.stringify(['w', 'old']),
      nostrNotificationItems: [row],
    };
    expect(
      Object.getOwnPropertyDescriptor(
        nostrNotificationsMixin,
        'visibleNostrNotifications',
      ).get.call(store),
    ).toEqual([]);
  } finally {
    await db.delete();
  }
});
it('merges Nostr and subscribed cards with source and dismissal filters', () => {
  const get = Object.getOwnPropertyDescriptor(
    subscribedReaderMixin,
    'visibleSubscribedFeedItems',
  ).get;
  const store = {
    subscribedFeedItems: [{ key: 'feed', published: '2026-01-01' }],
    visibleNostrNotifications: [
      { key: 'nostr', published: '2026-02-01' },
      { key: 'hidden', dismissed: true },
    ],
    feedSourceFilter: 'all',
  };
  expect(get.call(store).map((i) => i.key)).toEqual(['nostr', 'feed']);
  store.feedSourceFilter = 'feeds';
  expect(get.call(store).map((i) => i.key)).toEqual(['feed']);
  store.feedSourceFilter = 'nostr';
  store.showDismissedFeeds = true;
  expect(get.call(store)).toHaveLength(2);
});

it('terminates workers on identity replacement/logout and rejects late worker/liveQuery projections', async () => {
  const { openWorkspaceDb } = await import('../src/db.js');
  const workspaceKey = `nostr-lifecycle-${crypto.randomUUID()}`;
  const db = await openWorkspaceDb(workspaceKey);
  const workers = [],
    projections = [];
  class WorkerFixture {
    constructor() {
      workers.push(this);
      this.terminate = vi.fn();
      this.postMessage = vi.fn();
    }
  }
  vi.stubGlobal('Worker', WorkerFixture);
  vi.stubGlobal('window', new EventTarget());
  const store = Object.defineProperties(
    {},
    Object.getOwnPropertyDescriptors(nostrNotificationsMixin),
  );
  store.currentWorkspaceKey = workspaceKey;
  store.session = { npub: nip19.npubEncode(human) };
  store.createLiveSubscription = (_read, emit) => {
    projections.push(emit);
    return { unsubscribe: vi.fn() };
  };
  try {
    store.startNostrNotifications();
    expect(workers[0].postMessage.mock.calls[0][0].recipient).toBe(human);
    const row = await normalizeNostrNotification(sign(1, [['p', human]], 'Hi'), human, deps);
    projections[0]([row]);
    expect(store.visibleNostrNotifications).toHaveLength(1);
    store.session = { npub: nip19.npubEncode(sender) };
    expect(store.visibleNostrNotifications).toHaveLength(0);
    store.startNostrNotifications();
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    workers[0].onmessage({ data: { row, status: 'stale' } });
    projections[0]([row]);
    expect(store.visibleNostrNotifications).toHaveLength(0);
    expect(store.nostrNotificationStatus).not.toBe('stale');
    expect(await db.nostr_notifications.count()).toBe(0);
    store.session = null;
    store.startNostrNotifications();
    expect(workers[1].terminate).toHaveBeenCalledOnce();
    expect(store.visibleNostrNotifications).toHaveLength(0);
  } finally {
    store.disposeNostrNotifications();
    vi.unstubAllGlobals();
    await db.delete();
  }
});

it('bounds cached bodies and retains personal flags across eviction and redelivery', async () => {
  const db = new Dexie(`nostr-cache-${crypto.randomUUID()}`);
  db.version(1).stores({
    nostr_notifications: '&key, context, id',
    nostr_notification_states: '&key, context',
  });
  try {
    const key = JSON.stringify(['human', 'old']);
    await db.nostr_notification_states.put({ key, context: 'human', dismissed: true });
    await db.nostr_notifications.bulkPut(
      Array.from({ length: 500 }, (_, i) => ({
        id: `${i}`,
        key: JSON.stringify(['human', `${i}`]),
        context: 'human',
        published: '2026-01-01',
        saved: false,
      })),
    );
    await persistNostrNotification(db, 'human', { id: 'old', published: '2025-01-01' });
    expect(await db.nostr_notifications.count()).toBe(500);
    expect(await db.nostr_notifications.get(key)).toBeUndefined();
    expect(await db.nostr_notification_states.get(key)).toMatchObject({ dismissed: true });
    await persistNostrNotification(db, 'human', { id: 'old', published: '2027-01-01' });
    expect(await db.nostr_notifications.get(key)).toMatchObject({ dismissed: true });
  } finally {
    await db.delete();
  }
});

it('validates the independent BOLT11 description-hash reference vector and rejects malformed signatures', () => {
  // BOLT #11, "Now send $24 for an entire list of things (hashed)":
  // https://github.com/lightning/bolts/blob/master/11-payment-encoding.md
  const encoded =
    'lnbc20m1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqs9qrsgq7ea976txfraylvgzuxs8kgcw23ezlrszfnh8r6qtfpr6cxga50aj6txm9rxrydzd06dfeawfk6swupvz4erwnyutnjq7x39ymw6j38gp7ynn44';
  const description =
    'One piece of chocolate cake, one icecream cone, one pickle, one slice of swiss cheese, one slice of salami, one lollypop, one piece of cherry pie, one sausage, one cupcake, and one slice of watermelon';
  expect(zapInvoice(encoded, description)).toBe(2000000000);
  const decoded = bech32.decode(encoded, 8192);
  const corrupt = bech32.encode(
    decoded.prefix,
    [...decoded.words.slice(0, -104), ...Array(104).fill(0)],
    8192,
  );
  expect(zapInvoice(corrupt, description)).toBeNull();
  expect(zapInvoice(encoded, description, 'f'.repeat(64))).toBeNull();
});

it('excludes reactions to private messages even when target and recipient signatures are genuine', async () => {
  const target = sign(4, [['p', sender]], 'private ciphertext', humanKey);
  const reaction = sign(
    7,
    [
      ['e', target.id],
      ['p', human],
    ],
    '+',
  );
  expect(
    await normalizeNostrNotification(reaction, human, { ...deps, getEvent: async () => target }),
  ).toBeNull();
});

it('bounds candidate and original-event work when a relay exceeds requested limits', async () => {
  vi.useFakeTimers();
  let handlers;
  const close = vi.fn(),
    status = vi.fn();
  const pool = {
    querySync: vi.fn(async () => []),
    subscribeMany: (_r, _f, h) => {
      handlers = h;
      return { close };
    },
    close: vi.fn(),
  };
  const service = new NostrNotificationService({ recipient: human, pool, status });
  await service.start();
  for (let i = 0; i < 600; i++)
    handlers.onevent({ id: String(i), created_at: Math.floor(Date.now() / 1000) });
  expect(service.seen.size).toBe(500);
  expect(close).toHaveBeenCalledOnce();
  expect(status).toHaveBeenLastCalledWith(
    'Nostr activity limit reached. Refresh for another recent window.',
  );
  for (let i = 0; i < 600; i++) await service.getEvent(i.toString(16).padStart(64, '0'));
  expect(service.targets.size).toBe(500);
  expect(pool.querySync).toHaveBeenCalledTimes(502);
  service.dispose();
});

it('authorizes zaps only through bounded credential-free recipient provider requests', async () => {
  const fetchImpl = vi.fn(
    async () => new Response(JSON.stringify({ allowsNostr: true, nostrPubkey: provider })),
  );
  const service = new NostrNotificationService({
    recipient: human,
    pool: { close: vi.fn() },
    fetchImpl,
  });
  service.profile = { lud16: 'human@example.com' };
  expect(await service.getZapProvider()).toBe(provider);
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(fetchImpl.mock.calls[0]).toMatchObject([
    'https://example.com/.well-known/lnurlp/human',
    { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' },
  ]);
  service.dispose();
  const oversized = new NostrNotificationService({
    recipient: human,
    pool: { close: vi.fn() },
    fetchImpl: async () => new Response('x'.repeat(65537)),
  });
  oversized.profile = { lud16: 'human@example.com' };
  expect(await oversized.getZapProvider()).toBeNull();
  oversized.dispose();
});

it('retains a signed catch-up burst with four concurrent validations and drains it before rotation', async () => {
  vi.useFakeTimers();
  let handlers, resolveTarget;
  const targetGate = new Promise((resolve) => {
    resolveTarget = resolve;
  });
  const actorProfile = sign(
    0,
    [],
    JSON.stringify({ display_name: 'Alice Example', name: 'alice' }),
  );
  const emitted = [],
    pool = {
      querySync: vi.fn((_relays, filter) =>
        filter.ids
          ? targetGate
          : Promise.resolve(filter.authors?.[0] === sender ? [actorProfile] : []),
      ),
      subscribeMany: vi.fn((_r, _f, h) => {
        handlers = h;
        return { close: vi.fn() };
      }),
      close: vi.fn(),
    };
  const service = new NostrNotificationService({
    recipient: human,
    pool,
    emit: (row) => emitted.push(row),
  });
  await service.start();
  const burst = Array.from({ length: 40 }, (_, i) =>
    sign(
      7,
      [
        ['e', own.id],
        ['p', human],
      ],
      `reaction ${i}`,
    ),
  );
  for (const event of burst) {
    handlers.onevent(event);
    handlers.onevent(event);
  }
  expect(service.activeValidations).toBe(4);
  expect(service.queue).toHaveLength(36);
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  expect(pool.subscribeMany).toHaveBeenCalledOnce(); // no loss at cycle boundary
  resolveTarget([own]);
  await vi.advanceTimersByTimeAsync(0);
  expect(emitted).toHaveLength(40);
  expect(new Set(emitted.map((row) => row.id)).size).toBe(40);
  expect(emitted.every((row) => row.title === 'Reaction from Alice Example')).toBe(true);
  expect(service.activeValidations).toBe(0);
  expect(service.queue).toHaveLength(0);
  expect(
    pool.querySync.mock.calls.filter(([, filter]) => filter.authors?.[0] === sender),
  ).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(10000);
  expect(pool.subscribeMany).toHaveBeenCalledTimes(2);
  service.dispose();
});

it('rejects historical candidates client-side while allowing old verified originals', async () => {
  const now = Math.floor(Date.now() / 1000);
  const old = finalizeEvent(
    { kind: 1, tags: [['p', human]], content: 'Too old', created_at: now - 7 * 86400 - 1 },
    senderKey,
  );
  expect(await normalizeNostrNotification(old, human, { ...deps, now })).toBeNull();
  const oldOriginal = finalizeEvent(
    { kind: 1, tags: [], content: 'Old original', created_at: now - 365 * 86400 },
    humanKey,
  );
  const reaction = sign(
    7,
    [
      ['p', human],
      ['e', oldOriginal.id],
    ],
    '+',
  );
  expect(
    await normalizeNostrNotification(reaction, human, {
      ...deps,
      now,
      getEvent: async () => oldOriginal,
    }),
  ).toMatchObject({ type: 'Reaction' });
  vi.useFakeTimers();
  let handlers;
  const emit = vi.fn(),
    pool = {
      querySync: async () => [],
      subscribeMany: (_r, _f, h) => {
        handlers = h;
        return { close: vi.fn() };
      },
      close: vi.fn(),
    };
  const service = new NostrNotificationService({ recipient: human, pool, emit });
  await service.start();
  handlers.onevent(old);
  await vi.advanceTimersByTimeAsync(0);
  expect(service.seen.size).toBe(0);
  expect(emit).not.toHaveBeenCalled();
  service.dispose();
});

it('matches zap self-activity to the payer even when the recipient runs their own receipt provider', async () => {
  const remotePayer = receipt();
  const selfHosted = sign(9735, remotePayer.tags, '', humanKey);
  expect(
    await normalizeNostrNotification(selfHosted, human, {
      ...deps,
      getZapProvider: async () => human,
    }),
  ).toMatchObject({ type: 'Zap', actorNpub: nip19.npubEncode(sender) });
  const selfPaid = receipt(
    sign(
      9734,
      [
        ['p', human],
        ['relays', 'wss://nos.lol'],
      ],
      '',
      humanKey,
    ),
  );
  expect(await normalizeNostrNotification(selfPaid, human, deps)).toBeNull();
});
