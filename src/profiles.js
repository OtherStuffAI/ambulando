import { PUBLIC_NOSTR_RELAYS } from './nostr-relays.js';
import { nip19, SimplePool } from 'nostr-tools';
import { cacheProfile, getCachedProfile } from './db.js';

const PROFILE_KIND = 0;
const RELAYS = PUBLIC_NOSTR_RELAYS;
const FETCH_TIMEOUT_MS = 2500;
const PER_RELAY_TIMEOUT_MS = 1200;

export function npubToHex(npub) {
  const decoded = nip19.decode(npub);
  if (decoded.type !== 'npub') throw new Error(`Expected npub, got ${decoded.type}`);
  return decoded.data;
}

export async function fetchProfileByNpub(npub, options = {}) {
  if (!npub) return null;

  const force = options?.force === true;
  const cached = await getCachedProfile(npub);
  if (!force && cached) return cached;

  let pubkeyHex;
  try {
    pubkeyHex = npubToHex(npub);
  } catch {
    return null;
  }

  const pool = new SimplePool();
  const filter = {
    kinds: [PROFILE_KIND],
    authors: [pubkeyHex],
    limit: 1,
  };

  try {
    let events = [];

    try {
      events = await Promise.race([
        pool.querySync(RELAYS, filter),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS)),
      ]);
    } catch {
      const relayResults = await Promise.allSettled(
        RELAYS.map((relay) =>
          Promise.race([
            pool.querySync([relay], filter),
            new Promise((resolve) => setTimeout(() => resolve([]), PER_RELAY_TIMEOUT_MS)),
          ])
        )
      );

      events = relayResults
        .filter((result) => result.status === 'fulfilled')
        .flatMap((result) => result.value || []);
    }

    if (!events?.length) return cached || null;

    const latest = events.reduce((a, b) => (a.created_at > b.created_at ? a : b));
    const profile = JSON.parse(latest.content);
    await cacheProfile(npub, profile);
    return profile;
  } catch {
    return cached || null;
  } finally {
    pool.close(RELAYS);
  }
}
