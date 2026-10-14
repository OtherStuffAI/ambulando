# Public Nostr notifications in Feeds

The existing Deck Feeds reader merges subscribed feed cards with incoming public Nostr
mentions/replies (kind 1), reactions (7), reposts (6/16), and validated zap receipts
(9735). The source filter selects all activity, subscribed feeds or Nostr
notifications. Existing workspace Inbox/activity projections are unchanged. Cards
share deliberate safe headline navigation and read/save/dismiss controls. Nostr flags
are device-local; subscribed-feed flags continue through Tower.

A dedicated module worker owns relay discovery, subscriptions, signature checks,
target retrieval and zap-provider requests. It uses nostr-tools and the existing
public profile relays, with bounded workspace relay hints and verified kind 10002
read-relay discovery. It requests seven days, at most 200 events per relay, and
processes at most 500 unique candidates with four concurrent validations per cycle.
Subscription rotation normally occurs every five minutes; a retained burst finishes
before rotation, so slow lookups cannot discard its queue. Client-side normalization
rejects candidates outside the seven-day historical window even when a relay ignores
the requested filter. Target queries are capped at 500 per cycle and time out at 2.5
seconds. Initial discovery and subscription catch-up have bounded timeouts. Refresh
restarts Nostr independently of Tower/source errors; outages retain cache.

Verified event signatures are necessary. Unsupported kinds, private DMs and self-
authored events are excluded. A kind 1 p-tag identifies a mention; only a verified
reply target belonging to the human makes it a Reply. Reactions use the final e/p
target, and reposts require a verified original belonging to the human. Targets are
public notes, pictures, file metadata or long-form content (1/20/1063/30023/30024).
Embedded repost content must verify and match. Cards show a verified profile display
name when available, actor npub on hover, timestamp, notification type and relevant
inert text. Actor kind 0 lookups coalesce and are capped at 50 per cycle; cached
existing profiles supply a local fallback, and a shortened npub remains available when
no name can be resolved. Links encode the verified incoming event using nevent at
njump.me; ingestion never visits those links.

Zap validation requires a signed kind 9734 request, exactly one matching recipient,
matching e/a references and optional sender/provider tags, non-self public sender,
BOLT11 checksum, recoverable ECDSA signature, invoice amount and description hash, and
matching optional preimage. The receipt signer must match nostrPubkey from the signed-
in recipient's verified kind 0 LNURL metadata endpoint. This uses a bounded
credential-free HTTPS GET, without redirects/referrers or signing. Only public HTTPS
metadata endpoints are accepted. CORS/offline/absent provider metadata fails closed
for zaps. A provider-attested receipt is not independent payment proof.
Anonymous/private zaps are excluded. Event-specific split zap providers are not
supported by this profile-provider implementation.

Dexie version 38 adds local nostr_notifications and nostr_notification_states. Their
partition contains the workspace database key and human session npub; they are not
Tower record families and require no shared schema or backend mutation. The UI reads
via liveQuery. Bodies are capped at 500 per partition, prioritizing saved cards;
independent flags survive eviction and relay redelivery. All existing caches are
retained. No keys are exported or persisted by this feature.

Workspace stop, logout, runtime disposal and pagehide terminate the worker and
liveQuery subscription. Responses and flag writes check the captured partition;
rendering immediately excludes stale identity rows. A 250 ms identity guard also
terminates orphaned work when an identity changes outside normal lifecycle hooks.
Browser back/forward cache restoration restarts the terminated worker. Public relay
queries disclose the recipient pubkey to relays, and zap validation contacts that
recipient's Lightning provider. No workspace records are sent to either.

Coverage is bounded recent public activity, not full history. NIP-22 comments and
private messages are outside this initial integration. Unknown/uncached original
events cannot produce reactions/reposts; provider discovery failure suppresses zaps.
Local flags do not converge across devices. Automated signed fixtures and simulated
browser checks do not establish authenticated human/live relay acceptance.

Protocol references: [NIP-25 reactions](https://github.com/nostr-protocol/nips/blob/master/25.md), [NIP-18 reposts](https://github.com/nostr-protocol/nips/blob/master/18.md), [NIP-57 zap receipts](https://github.com/nostr-protocol/nips/blob/master/57.md), and [BOLT11 invoices](https://github.com/lightning/bolts/blob/master/11-payment-encoding.md).
