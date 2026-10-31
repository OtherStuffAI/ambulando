import { afterEach, describe, expect, it, vi } from 'vitest';
import { nip19 } from 'nostr-tools';
vi.mock('../src/db.js', () => ({ getCachedProfile: vi.fn().mockResolvedValue({ name: 'Saved' }) }));

const identity = n => nip19.npubEncode(n.toString(16).padStart(64, '0'));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetModules(); });
describe('bounded profile worker bridge', () => {
  it('coalesces aliases and starts timeouts only when queued work dispatches', async () => {
    vi.useFakeTimers(); const messages = []; let worker;
    vi.stubGlobal('Worker', class {
      constructor() { worker = this; }
      postMessage(message) { messages.push(message); }
      terminate() {}
    });
    const { fetchProfileByNpub } = await import('../src/profiles.js');
    const first = fetchProfileByNpub(identity(1));
    expect(fetchProfileByNpub('1'.padStart(64, '0'))).toBe(first);
    const promises = [first, ...Array.from({ length: 39 }, (_, i) => fetchProfileByNpub(identity(i + 2)))];
    await vi.waitFor(() => expect(messages).toHaveLength(4));
    await vi.advanceTimersByTimeAsync(29_000);
    // Drain ten waves: total queue time exceeds the per-dispatch deadline.
    for (let offset = 0; offset < 40; offset += 4) {
      const wave = messages.slice(offset, offset + 4);
      expect(wave).toHaveLength(4);
      for (const message of wave) worker.onmessage({ data: { id: message.id, profile: { name: 'Recovered' } } });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect((await Promise.all(promises)).every(p => p.name === 'Recovered')).toBe(true);
  });

  it('keeps cached data when worker construction fails and retries the next call', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('blocked'); } });
    const { fetchProfileByNpub } = await import('../src/profiles.js');
    expect(await fetchProfileByNpub(identity(1))).toEqual({ name: 'Saved' });
    expect(await fetchProfileByNpub(identity(2))).toEqual({ name: 'Saved' });
  });
});
