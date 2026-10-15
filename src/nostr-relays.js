// Public profile/notification relays; never use a Tower transport as a public relay.
export const PUBLIC_NOSTR_RELAYS = [
  'wss://relay.primal.net',
  'wss://nos.lol',
  'wss://purplepag.es',
];
export function publicNostrRelays(configured = []) {
  return [
    ...new Set(
      [...configured, ...PUBLIC_NOSTR_RELAYS].filter((value) => {
        try {
          const url = new URL(value);
          return url.protocol === 'wss:' && !url.username && !url.password;
        } catch {
          return false;
        }
      }),
    ),
  ].slice(0, 6);
}

// Notification inboxes are separate from profile indexes. Canonicalize before
// applying the bound so a trailing slash cannot displace a recipient read relay.
export function notificationRelays(configured = []) {
  const relays = [];
  for (const value of configured) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'wss:' || url.username || url.password || url.hash) continue;
      const normalized = url.pathname === '/' && !url.search ? url.href.slice(0, -1) : url.href;
      if (!relays.includes(normalized)) relays.push(normalized);
    } catch {
      /* Ignore malformed public relay hints. */
    }
  }
  return relays.slice(0, 6);
}
export const NOTIFICATION_FALLBACK_RELAYS = ['wss://relay.primal.net', 'wss://relay.damus.io'];
export function notificationInboxRelays(relayEvent, configured = []) {
  const reads =
    relayEvent?.tags
      .filter((tag) => tag[0] === 'r' && (!tag[2] || tag[2] === 'read'))
      .map((tag) => tag[1]) || [];
  return notificationRelays([
    ...notificationRelays(reads).slice(0, 4),
    ...NOTIFICATION_FALLBACK_RELAYS,
    ...configured,
  ]);
}
