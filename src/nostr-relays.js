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
