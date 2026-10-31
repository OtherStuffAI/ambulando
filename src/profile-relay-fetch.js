import { SimplePool, verifyEvent } from 'nostr-tools';
import { PUBLIC_NOSTR_RELAYS } from './nostr-relays.js';
import { canonicalProfileNpub, profileHex, usableProfileText } from './profile-identity.js';
import { cacheProfile, getCachedProfileRow, markProfileLookupAttempt } from './db.js';

const FRESH_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const inFlight = new Map();
const attempts = new Map();
let active = 0;
const waiters = [];

// Runs only in the profile worker in the browser. Ports permit isolated tests
// with real IndexedDB and signed kind-0 fixtures, without live relay mutations.
export function fetchRelayProfile(identity, options = {}, ports = {}) {
  const npub = canonicalProfileNpub(identity);
  if (inFlight.has(npub)) return inFlight.get(npub);
  const promise = fetchOne(npub, options, ports).finally(() => inFlight.delete(npub));
  inFlight.set(npub, promise);
  return promise;
}

async function fetchOne(npub, options, ports) {
  const row = await getCachedProfileRow(npub);
  const now = (ports.now || Date.now)();
  if (!options.force && usableProfileText(row?.profile?.display_name, row?.profile?.name)
    && row?.cachedAt && now - row.cachedAt < FRESH_MS) return row.profile;
  if (attempts.has(npub) && now - attempts.get(npub) < RETRY_MS) return row?.profile || null;
  let hex;
  try { hex = profileHex(npub); } catch { return row?.profile || null; }
  // Bound simultaneous identities, including explicit manual refreshes.
  if (active >= 4) await new Promise(resolve => waiters.push(resolve));
  active++;
  const attemptAt = (ports.now || Date.now)();
  let pool;
  let timer;
  try {
    if (!await markProfileLookupAttempt(npub, attemptAt, RETRY_MS)) return row?.profile || null;
    attempts.set(npub, attemptAt);
    if (attempts.size > 2000) attempts.delete(attempts.keys().next().value);
    pool = ports.pool || new SimplePool({ maxWaitForConnection: 1200 });
    const events = await Promise.race([
      pool.querySync(PUBLIC_NOSTR_RELAYS, { kinds: [0], authors: [hex], limit: 1 }, { maxWait: 1200 }),
      new Promise(resolve => { timer = setTimeout(() => resolve([]), 4000); }),
    ]);
    const candidates = (events || []).filter(event => event.kind === 0
      && event.pubkey === hex && event.created_at <= Math.floor(now / 1000) + 300
      && verifyEvent(event)).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
    for (const event of candidates) {
      try {
        const profile = JSON.parse(event.content);
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) continue;
        if (!Object.values(profile).some(value => typeof value === 'string' && value.trim())) continue;
        return await cacheProfile(npub, profile, event);
      } catch { /* a malformed newer event must not hide an older valid one */ }
    }
    return row?.profile || null;
  } catch {
    return row?.profile || null;
  } finally {
    clearTimeout(timer);
    try { pool?.close(PUBLIC_NOSTR_RELAYS); } catch { /* release lane even on teardown failure */ }
    active--;
    waiters.shift()?.();
  }
}
