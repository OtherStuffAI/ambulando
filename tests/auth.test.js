import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

let storedCreds = null;
const { refreshCredentialExpiryMock } = vi.hoisted(() => ({
  refreshCredentialExpiryMock: vi.fn(async () => {}),
}));

vi.mock('../src/auth/secure-store.js', () => ({
  storeCredentials: vi.fn(async (record) => {
    storedCreds = { ...(storedCreds || {}), ...record };
  }),
  getStoredCredentials: vi.fn(async () => storedCreds),
  clearCredentials: vi.fn(async () => {
    storedCreds = null;
  }),
  refreshCredentialExpiry: refreshCredentialExpiryMock,
}));

vi.mock('nostr-tools', () => ({
  generateSecretKey: () => new Uint8Array(32).fill(1),
  getPublicKey: () => 'a'.repeat(64),
  finalizeEvent: (template) => ({
    ...template,
    id: 'test-id',
    sig: 'test-sig',
    pubkey: 'a'.repeat(64),
  }),
  nip19: {
    decode: (value) => {
      if (!value.startsWith('nsec1')) throw new Error('invalid');
      return { type: 'nsec', data: new Uint8Array(32).fill(2) };
    },
    npubEncode: (hex) => `npub1${hex.slice(0, 59)}`,
    nsecEncode: () => 'nsec1mocksecret',
  },
  nip44: {
    getConversationKey: () => 'conversation-key',
    encrypt: (plaintext) => `enc:${plaintext}`,
    decrypt: (ciphertext) => ciphertext.replace(/^enc:/, ''),
  },
}));

vi.mock('nostr-tools/nip46', () => ({
  parseBunkerInput: async () => ({ relay: 'wss://relay.test' }),
  BunkerSigner: class {
    async connect() {}
    async signEvent(event) {
      return { ...event, pubkey: 'b'.repeat(64), id: 'bunker-id', sig: 'bunker-sig' };
    }
  },
}));

import {
  APP_TAG,
  LOGIN_KIND,
  STORAGE_KEYS,
  buildUnsignedEvent,
  createNip98AuthHeader,
  bytesToHex,
  clearAutoLogin,
  clearExtensionSignerBridge,
  clearMemoryCredentials,
  decodeNsec,
  getAutoLoginMethod,
  getMemoryPubkey,
  hexToBytes,
  pubkeyToNpub,
  setAutoLogin,
  setExtensionSignerBridge,
  setMemoryPubkey,
  signEventWithExtension,
  signLoginEvent,
  signNostrEvent,
  tryAutoLoginFromStorage,
  waitForExtensionSigner,
} from '../src/auth/nostr.js';

describe('auth/nostr helpers', () => {
  beforeEach(() => {
    storedCreds = null;
    globalThis.window = globalThis;
    localStorage.clear();
    clearMemoryCredentials();
    clearExtensionSignerBridge();
    refreshCredentialExpiryMock.mockClear();
    delete window.nostr;
  });

  it('buildUnsignedEvent creates a login event with method tag', () => {
    const event = buildUnsignedEvent('ephemeral');
    expect(event.kind).toBe(LOGIN_KIND);
    expect(event.tags).toContainEqual(['app', APP_TAG]);
    expect(event.tags).toContainEqual(['method', 'ephemeral']);
  });

  it('hexToBytes and bytesToHex round-trip', () => {
    const original = 'deadbeef';
    expect(bytesToHex(hexToBytes(original))).toBe(original);
  });

  it('decodeNsec accepts nsec values', () => {
    const secret = decodeNsec('nsec1test');
    expect(secret).toBeInstanceOf(Uint8Array);
    expect(secret.length).toBe(32);
  });

  it('setAutoLogin persists and clearAutoLogin removes auth keys', async () => {
    setAutoLogin('ephemeral', 'f'.repeat(64));
    expect(getAutoLoginMethod()).toBe('ephemeral');
    expect(localStorage.getItem(STORAGE_KEYS.AUTO_LOGIN_PUBKEY)).toBe('f'.repeat(64));

    await clearAutoLogin();
    expect(getAutoLoginMethod()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.AUTO_LOGIN_PUBKEY)).toBeNull();
  });

  it('login with extension uses the browser signer pubkey', async () => {
    window.nostr = {
      getPublicKey: vi.fn(async () => 'c'.repeat(64)),
      signEvent: vi.fn(async (event) => ({ ...event, id: 'ext-id', sig: 'ext-sig' })),
    };

    const event = await signLoginEvent('extension');
    expect(event.pubkey).toBe('c'.repeat(64));
  });

  it('rejects extension auth if the signer pubkey changed since login', async () => {
    window.nostr = {
      getPublicKey: vi.fn(async () => 'c'.repeat(64)),
      signEvent: vi.fn(async (event) => ({ ...event, id: 'ext-id', sig: 'ext-sig' })),
    };

    await signLoginEvent('extension');

    window.nostr.getPublicKey = vi.fn(async () => 'd'.repeat(64));
    window.nostr.signEvent = vi.fn(async (event) => ({ ...event, pubkey: 'd'.repeat(64), id: 'ext-id-2', sig: 'ext-sig-2' }));

    await expect(
      createNip98AuthHeader('https://example.test/api/v4/storage/obj-1/complete', 'POST', { ok: true }),
    ).rejects.toThrow('NIP-07 signer pubkey changed since login. Sign in again.');
  });

  it('gives hosted signup retries distinct direct user events for the exact body hash', async () => {
    window.nostr = {
      getPublicKey: vi.fn(async () => 'c'.repeat(64)),
      signEvent: vi.fn(async (event) => ({ ...event, id: 'ext-id', sig: 'ext-sig' })),
    };
    await signLoginEvent('extension');
    const body = '{"workspace_name":"Café","idempotency_key":"6c5e818f-bf8a-4df8-9ffc-ed5753ce5891","terms_version":"hosted-free-v1"}';
    const url = 'https://tower.example/api/v4/flightdeck-pg/hosted/workspaces';
    const first = JSON.parse(atob((await createNip98AuthHeader(url, 'POST', body, { freshContent: true })).slice(6)));
    const second = JSON.parse(atob((await createNip98AuthHeader(url, 'POST', body, { freshContent: true })).slice(6)));
    const hash = createHash('sha256').update(new TextEncoder().encode(body)).digest('hex');
    expect(first.tags).toEqual([['u', url], ['method', 'POST'], ['payload', hash]]);
    expect(second.tags).toEqual(first.tags);
    expect(first.content).not.toBe(second.content);
    expect(first.kind).toBe(27235);
  });

  it('waits briefly for a late-injected extension signer', async () => {
    setTimeout(() => {
      window.nostr = {
        getPublicKey: vi.fn(async () => 'd'.repeat(64)),
        signEvent: vi.fn(async (event) => ({ ...event, id: 'late-id', sig: 'late-sig' })),
      };
    }, 20);

    await expect(waitForExtensionSigner(250, 10)).resolves.toBe(true);
  });

  it('restores a persisted extension session before mobile signer injection', async () => {
    storedCreds = {
      method: 'extension',
      pubkey: 'c'.repeat(64),
      authEvent: { id: 'stored-login' },
    };

    await expect(tryAutoLoginFromStorage()).resolves.toEqual({
      method: 'extension',
      pubkey: 'c'.repeat(64),
    });
    expect(getMemoryPubkey()).toBe('c'.repeat(64));
    expect(refreshCredentialExpiryMock).toHaveBeenCalledOnce();
  });

  it('createNip98AuthHeader signs a request with the current session', async () => {
    await signLoginEvent('ephemeral');
    const header = await createNip98AuthHeader('https://example.test/api/v4/records', 'GET');
    expect(header.startsWith('Nostr ')).toBe(true);
    const encoded = header.slice(6);
    const event = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    expect(event.kind).toBe(LOGIN_KIND);
    expect(event.tags).toContainEqual(['u', 'https://example.test/api/v4/records']);
    expect(event.tags).toContainEqual(['method', 'GET']);
    expect(refreshCredentialExpiryMock).toHaveBeenCalledTimes(1);
  });

  it('recovers the extension signing queue after a hung signing request times out', async () => {
    vi.useFakeTimers();
    window.nostr = {
      getPublicKey: vi.fn(async () => 'c'.repeat(64)),
      signEvent: vi.fn(async (event) => ({ ...event, id: 'login-id', sig: 'login-sig' })),
    };
    await signLoginEvent('extension');

    let signCount = 0;
    window.nostr.signEvent = vi.fn((event) => {
      signCount += 1;
      if (signCount === 1) return new Promise(() => {});
      return Promise.resolve({ ...event, id: `ext-id-${signCount}`, sig: `ext-sig-${signCount}` });
    });

    const first = createNip98AuthHeader('https://example.test/api/v4/slow', 'GET', null, { signTimeoutMs: 20 });
    const firstAssertion = expect(first).rejects.toThrow('NIP-07 signing timed out.');
    await vi.advanceTimersByTimeAsync(20);
    await firstAssertion;

    const second = createNip98AuthHeader('https://example.test/api/v4/grants', 'GET', null, { signTimeoutMs: 20 });
    await expect(second).resolves.toMatch(/^Nostr /);
    expect(window.nostr.signEvent).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('starts each extension signing allowance only after its queued job reaches the signer', async () => {
    vi.useFakeTimers();
    window.nostr = {
      getPublicKey: vi.fn(async () => 'c'.repeat(64)),
      signEvent: vi.fn(async (event) => ({ ...event, id: 'login-id', sig: 'login-sig' })),
    };
    await signLoginEvent('extension');

    let signCount = 0;
    window.nostr.signEvent = vi.fn((event) => {
      signCount += 1;
      if (signCount === 1) return new Promise(() => {});
      return new Promise((resolve) => {
        setTimeout(() => resolve({ ...event, id: 'queued-id', sig: 'queued-sig' }), 15);
      });
    });

    const first = createNip98AuthHeader('https://example.test/api/v4/slow', 'GET', null, { signTimeoutMs: 40 });
    const second = createNip98AuthHeader('https://example.test/api/v4/queued', 'GET', null, { signTimeoutMs: 20 });
    const firstAssertion = expect(first).rejects.toThrow('NIP-07 signing timed out.');

    await vi.advanceTimersByTimeAsync(20);
    expect(window.nostr.signEvent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    await firstAssertion;
    expect(window.nostr.signEvent).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15);
    await expect(second).resolves.toMatch(/^Nostr /);
    vi.useRealTimers();
  });

  it('timestamps a queued DELETE proof when it reaches the signer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T03:00:00.000Z'));
    window.nostr = {
      getPublicKey: vi.fn(async () => 'c'.repeat(64)),
      signEvent: vi.fn(async (event) => ({ ...event, id: 'login-id', sig: 'login-sig' })),
    };
    await signLoginEvent('extension');

    let releaseFirst;
    window.nostr.signEvent = vi.fn((event) => {
      if (!releaseFirst) {
        return new Promise((resolve) => {
          releaseFirst = () => resolve({ ...event, id: 'slow-id', sig: 'slow-sig' });
        });
      }
      return Promise.resolve({ ...event, id: 'delete-id', sig: 'delete-sig' });
    });

    const first = createNip98AuthHeader('https://example.test/api/v4/slow', 'GET', null, { signTimeoutMs: 600_000 });
    const deletion = createNip98AuthHeader('https://example.test/api/v4/channels/channel-1', 'DELETE', null, { signTimeoutMs: 600_000 });
    await vi.advanceTimersByTimeAsync(301_000);
    releaseFirst();
    await first;
    const header = await deletion;
    const event = JSON.parse(Buffer.from(header.slice(6), 'base64').toString('utf8'));

    expect(event.created_at).toBe(Math.floor(Date.now() / 1000));
    expect(event.tags).toContainEqual(['u', 'https://example.test/api/v4/channels/channel-1']);
    expect(event.tags).toContainEqual(['method', 'DELETE']);
    vi.useRealTimers();
  });

  it('runs a later mutation before queued reads and preserves mutation FIFO', async () => {
    window.nostr = {
      getPublicKey: vi.fn(async () => 'c'.repeat(64)),
      signEvent: vi.fn(async (event) => ({ ...event, id: 'login-id', sig: 'login-sig' })),
    };
    await signLoginEvent('extension');

    let releaseActiveRead;
    const signerCalls = [];
    window.nostr.signEvent = vi.fn((event) => {
      const urlTag = event.tags.find(([name]) => name === 'u');
      signerCalls.push(urlTag?.[1] || `kind:${event.kind}`);
      if (signerCalls.length === 1) {
        return new Promise((resolve) => {
          releaseActiveRead = () => resolve({ ...event, id: 'active-read', sig: 'sig' });
        });
      }
      return Promise.resolve({ ...event, id: `signed-${signerCalls.length}`, sig: 'sig' });
    });

    const activeRead = createNip98AuthHeader('https://example.test/read-active', 'GET');
    await vi.waitFor(() => expect(window.nostr.signEvent).toHaveBeenCalledTimes(1));
    const queuedRead = createNip98AuthHeader('https://example.test/read-queued', 'GET');
    const firstMutation = createNip98AuthHeader('https://example.test/mutation-1', 'DELETE');
    const secondMutation = createNip98AuthHeader('https://example.test/mutation-2', 'DELETE');

    releaseActiveRead();
    await Promise.all([activeRead, queuedRead, firstMutation, secondMutation]);

    expect(signerCalls).toEqual([
      'https://example.test/read-active',
      'https://example.test/mutation-1',
      'https://example.test/mutation-2',
      'https://example.test/read-queued',
    ]);
  });

  it('prioritizes explicit application event signatures over queued reads', async () => {
    window.nostr = {
      getPublicKey: vi.fn(async () => 'c'.repeat(64)),
      signEvent: vi.fn(async (event) => ({ ...event, id: 'login-id', sig: 'login-sig' })),
    };
    await signLoginEvent('extension');

    let releaseActiveRead;
    const signerCalls = [];
    window.nostr.signEvent = vi.fn((event) => {
      signerCalls.push(event.kind === 33358 ? 'instruction' : event.tags.find(([name]) => name === 'u')?.[1]);
      if (signerCalls.length === 1) {
        return new Promise((resolve) => {
          releaseActiveRead = () => resolve({ ...event, id: 'active-read', sig: 'sig' });
        });
      }
      return Promise.resolve({ ...event, id: `signed-${signerCalls.length}`, sig: 'sig' });
    });

    const activeRead = createNip98AuthHeader('https://example.test/read-active', 'GET');
    await vi.waitFor(() => expect(window.nostr.signEvent).toHaveBeenCalledTimes(1));
    const queuedRead = createNip98AuthHeader('https://example.test/read-queued', 'GET');
    const instruction = signNostrEvent({ kind: 33358, created_at: 1, tags: [], content: 'proof' });

    releaseActiveRead();
    await Promise.all([activeRead, queuedRead, instruction]);
    expect(signerCalls).toEqual([
      'https://example.test/read-active',
      'instruction',
      'https://example.test/read-queued',
    ]);
  });

  it('recovers the NIP-07 priority queue after a signer rejection', async () => {
    window.nostr = {
      getPublicKey: vi.fn(async () => 'c'.repeat(64)),
      signEvent: vi.fn(async (event) => ({ ...event, id: 'login-id', sig: 'login-sig' })),
    };
    await signLoginEvent('extension');
    window.nostr.signEvent = vi.fn()
      .mockRejectedValueOnce(new Error('Signer denied the request.'))
      .mockImplementationOnce(async (event) => ({ ...event, id: 'recovered', sig: 'sig' }));

    await expect(createNip98AuthHeader('https://example.test/rejected', 'GET'))
      .rejects.toThrow('Signer denied the request.');
    await expect(createNip98AuthHeader('https://example.test/recovered', 'GET'))
      .resolves.toMatch(/^Nostr /);
  });

  it('applies the same priority scheduling to the extension bridge lane', async () => {
    delete window.nostr;
    let releaseActiveRead;
    const signerCalls = [];
    setExtensionSignerBridge({
      getPublicKey: vi.fn(async () => 'c'.repeat(64)),
      signEvent: vi.fn((event) => {
        signerCalls.push(event.content);
        if (signerCalls.length === 1) {
          return new Promise((resolve) => {
            releaseActiveRead = () => resolve({ ...event, id: 'active', sig: 'sig' });
          });
        }
        return Promise.resolve({ ...event, id: `signed-${signerCalls.length}`, sig: 'sig' });
      }),
    });

    const activeRead = signEventWithExtension({ kind: 1, tags: [], content: 'read-active' });
    await vi.waitFor(() => expect(signerCalls).toEqual(['read-active']));
    const queuedRead = signEventWithExtension({ kind: 1, tags: [], content: 'read-queued' });
    const mutation = signEventWithExtension(
      { kind: 33358, tags: [], content: 'mutation' },
      { priority: 'high' },
    );

    releaseActiveRead();
    await Promise.all([activeRead, queuedRead, mutation]);
    expect(signerCalls).toEqual(['read-active', 'mutation', 'read-queued']);
  });

  it('pubkeyToNpub returns an npub string', async () => {
    setMemoryPubkey('a'.repeat(64));
    expect(getMemoryPubkey()).toBe('a'.repeat(64));
    const npub = await pubkeyToNpub('a'.repeat(64));
    expect(npub.startsWith('npub1')).toBe(true);
  });
});
