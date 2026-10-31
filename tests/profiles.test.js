import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { cacheProfile, getCachedProfile, upsertAddressBookPerson, getAddressBookPeople } from '../src/db.js';
import { fetchRelayProfile } from '../src/profile-relay-fetch.js';

let index = 1;
function identity() {
  const key = new Uint8Array(32); key[31] = index++;
  const hex = getPublicKey(key);
  return { key, hex, npub: nip19.npubEncode(hex) };
}
function event(id, profile, created_at = 100) {
  return finalizeEvent({ kind: 0, tags: [], content: JSON.stringify(profile), created_at }, id.key);
}
const now = () => 10_000_000;
function pool(events) { return { querySync: vi.fn().mockResolvedValue(events), close: vi.fn() }; }
async function legacy(row) {
  const db = new Dexie('wingman-fd-shared'); await db.open();
  await db.table('profiles').put(row); db.close();
}

describe('persisted Nostr profile recovery', () => {
  beforeEach(async () => { await getCachedProfile('bootstrap'); });
  it('retains an expired profile on read and through a database reopen (old failure: deleted after 24h)', async () => {
    const id = identity();
    await legacy({ pubkey: id.npub, cachedAt: 1, profile: { name: 'Known', picture: 'https://example.com/a.png' } });
    expect(await getCachedProfile(id.hex)).toMatchObject({ name: 'Known' });
    const db = new Dexie('wingman-fd-shared'); await db.open();
    expect(await db.table('profiles').get(id.npub)).toBeTruthy(); db.close();
    expect(await getCachedProfile(id.npub)).toMatchObject({ picture: 'https://example.com/a.png' });
  });

  it('maps hex/npub to one durable profile and retains legacy hex rows', async () => {
    const id = identity();
    await legacy({ pubkey: id.hex, cachedAt: 1, profile: { name: 'Legacy' } });
    expect(await getCachedProfile(id.npub)).toMatchObject({ name: 'Legacy' });
    await cacheProfile(id.hex, { picture: 'https://example.com/a.png' });
    expect(await getCachedProfile(id.npub)).toMatchObject({ name: 'Legacy', picture: 'https://example.com/a.png' });
  });

  it('merges sparse and empty profiles without losing names or avatars, and rejects older data', async () => {
    const id = identity();
    await cacheProfile(id.npub, { display_name: 'Known', picture: 'https://example.com/a.png' }, { created_at: 100 });
    await cacheProfile(id.hex, { name: '', picture: null }, { created_at: 200 });
    await cacheProfile(id.npub, { name: 'Stale' }, { created_at: 150 });
    expect(await getCachedProfile(id.hex)).toMatchObject({ name: 'Known', picture: 'https://example.com/a.png' });
    await cacheProfile(id.npub, { name: 'Latest' }, { created_at: 300 });
    expect(await getCachedProfile(id.npub)).toMatchObject({ name: 'Latest', display_name: 'Latest' });
  });

  it('does not downgrade saved address book data with empty membership fields', async () => {
    const id = identity();
    await upsertAddressBookPerson({ npub: id.npub, label: 'Known', avatar_url: 'https://example.com/a.png' });
    await upsertAddressBookPerson({ npub: id.hex, label: '  ', avatar_url: '' });
    expect((await getAddressBookPeople()).find(p => p.npub === id.npub)).toMatchObject({ label: 'Known', avatar_url: 'https://example.com/a.png' });
  });

  it('coalesces hex/npub and recovers a miss after cooldown without a request storm', async () => {
    const id = identity(); const relay = pool([]);
    await Promise.all([fetchRelayProfile(id.npub, {}, { pool: relay, now }), fetchRelayProfile(id.hex, {}, { pool: relay, now })]);
    await fetchRelayProfile(id.npub, { force: true }, { pool: relay, now });
    expect(relay.querySync).toHaveBeenCalledTimes(1);
    relay.querySync.mockResolvedValue([event(id, { name: 'Recovered' })]);
    expect(await fetchRelayProfile(id.hex, {}, { pool: relay, now: () => now() + 61_000 })).toMatchObject({ name: 'Recovered' });
    expect(await getCachedProfile(id.npub)).toMatchObject({ name: 'Recovered' });
    expect(relay.querySync.mock.calls[0][0]).toEqual(['wss://relay.primal.net', 'wss://nos.lol', 'wss://purplepag.es']);
    expect(relay.querySync.mock.calls[0][2]).toEqual({ maxWait: 1200 });
  });

  it('returns retained data on offline, relay failure and empty kind-0 response', async () => {
    for (const response of ['offline', 'empty']) {
      const id = identity(); const profile = { name: 'Known', picture: 'https://example.com/a.png' };
      await legacy({ pubkey: id.npub, cachedAt: 1, profile });
      const relay = pool([event(id, {})]);
      if (response === 'offline') relay.querySync.mockRejectedValue(new Error('offline'));
      expect(await fetchRelayProfile(id.npub, { force: true }, { pool: relay, now })).toMatchObject(profile);
      expect(await getCachedProfile(id.hex)).toMatchObject(profile);
    }
  });

  it('chooses the latest valid signed metadata, ignoring invalid signatures and malformed newer content', async () => {
    const id = identity();
    const invalid = JSON.parse(JSON.stringify({ ...event(id, { name: 'Forged' }, 400), sig: '0'.repeat(128) }));
    const malformed = finalizeEvent({ kind: 0, tags: [], content: '{', created_at: 300 }, id.key);
    const relay = pool([invalid, malformed, event(id, { name: 'Latest' }, 200), event(id, { name: 'Old' }, 100)]);
    expect(await fetchRelayProfile(id.npub, {}, { pool: relay, now })).toMatchObject({ name: 'Latest' });
  });
  it('merges competing legacy keys using event order without mixing timestamp units', async () => {
    const id = identity();
    await legacy({ pubkey: id.npub, cachedAt: Date.now(), created_at: 300, profile: { name: 'Versioned' } });
    await legacy({ pubkey: id.hex, cachedAt: Date.now() + 1000, profile: { name: 'Unversioned', picture: 'https://example.com/legacy.png' } });
    expect(await getCachedProfile(id.hex)).toMatchObject({ name: 'Versioned', picture: 'https://example.com/legacy.png' });
  });

  it('renews freshness for an identical valid event, while failed revalidation remains retryable', async () => {
    const id = identity(); const signed = event(id, { name: 'Known' });
    await legacy({ pubkey: id.npub, cachedAt: 1, created_at: signed.created_at, event_id: signed.id, profile: { name: 'Known' } });
    const relay = pool([signed]);
    await fetchRelayProfile(id.npub, {}, { pool: relay, now });
    const db = new Dexie('wingman-fd-shared'); await db.open();
    const updated = await db.table('profiles').get(id.npub);
    expect(updated.cachedAt).toBeGreaterThan(1);
    db.close();
    await fetchRelayProfile(id.npub, {}, { pool: relay });
    expect(relay.querySync).toHaveBeenCalledTimes(1);

    const other = identity();
    await legacy({ pubkey: other.npub, cachedAt: 1, profile: { name: 'Stale but retained' } });
    const failing = pool([]); failing.querySync.mockRejectedValue(new Error('offline'));
    await fetchRelayProfile(other.npub, {}, { pool: failing, now });
    failing.querySync.mockResolvedValue([event(other, { name: 'Recovered' })]);
    expect(await fetchRelayProfile(other.hex, {}, { pool: failing, now: () => now() + 61_000 })).toMatchObject({ name: 'Recovered' });
  });

});
