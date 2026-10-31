import { nip19 } from 'nostr-tools';

// Only cryptographically decodable public identities are canonicalized. Retain
// unknown legacy strings for local lookup; never send them to relays.
export function canonicalProfileNpub(value) {
  const text = String(value || '').trim();
  try {
    if (/^[a-f0-9]{64}$/i.test(text)) return nip19.npubEncode(text.toLowerCase());
    const decoded = nip19.decode(text.toLowerCase());
    if (decoded.type === 'npub') return nip19.npubEncode(decoded.data);
  } catch { /* legacy local key */ }
  return text;
}

export function profileHex(value) {
  const decoded = nip19.decode(canonicalProfileNpub(value));
  if (decoded.type !== 'npub') throw new Error('Expected public Nostr identity');
  return decoded.data;
}

export function usableProfileText(...values) {
  return values.find(value => typeof value === 'string' && value.trim())?.trim() || null;
}

export function mergeUsableProfile(previous = {}, incoming = {}) {
  const next = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {};
  const merged = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === 'string' && value.trim()) merged[key] = value.trim();
  }
  // Canonical display fields prevent an older alias masking a newer name.
  const name = usableProfileText(next.display_name, next.displayName, next.name, next.username);
  if (name) merged.display_name = merged.name = name;
  const picture = usableProfileText(next.picture, next.image, next.avatar_url, next.avatarUrl, next.avatar);
  if (picture) merged.picture = picture;
  return merged;
}
