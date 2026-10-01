# Flight Deck WApp feed reader — proposed

Status: **proposed / unimplemented**. Companion to canonical
[`wapp-feed-v1-proposed`, revision `1`](../../../tower/docs/contract/wapp-feed-v1-proposed.md).
The canonical contract controls schemas, identity, URL safety, errors and open
decisions. Keep revision pins synchronized in a coordinated review; do not copy
or redefine the wire contract here. Proposed endpoints are not current capabilities.

## Reader behavior and F2

Feed is an information/link reader. Feed + chooses an authorized app across
connected Autopilots, authenticates `/feed/list` as the actual reader, and lets the
reader select a permitted feed. App selection supplies registered installation
identity/origin/transport. Listing an app or saving a subscription never grants
feed or graph access. Also support public JSON/RSS URL entry and podcast attachment
metadata. Do not claim universal no-CORS public support until conditional A1 or an
existing supported transport is proven.

One item action is deliberate click opening the source-provided URL. No approval
protocol, action RPC, destination prefetch, preview scrape, hover fetch or health
probe. WApp owns all effects, destination ACL and repeat opens. Personal
read/dismiss/save flags do not acknowledge WApp execution. Validate URL syntax
locally; retain the canonical `?story=<headline>` link rather than guessing another
Book of Sand article route. Attachments do not autoplay or download on refresh.

## F1 data ownership

State path: **TowerSyncService → Dexie → liveQuery → Alpine**. Register proposed
subscription and personal-state read/command families with TowerSyncService, typed
adapters/translators and recovery/event coverage after T1 exists. Dexie stores
materialized normalized rows; UI shapes remain separate from transport rows.
Alpine stores selection, drafts and status intent, not authoritative collections.
See [implemented service contract](tower-sync-service.md).

A separate source-fetch service resolves active subscriptions, signs exact URLs,
fetches WApp/public content and writes reader-partitioned normalized Dexie rows and
per-source status. It is not Tower network sync and must not add Tower polling or
SSE owners. Heavy feed parsing, crypto and migration work belongs off the main
thread. UI subscribes via liveQuery; component-owned network timers are forbidden.

Partition local content by logical Tower backend + workspace + reader actor +
subscription/source tuple. Never share private rows, HTTP cache or validators
between readers. Auth denial, registry revocation, logout/lock and account/workspace
switch cancel fetches, invalidate generations and purge private bodies. Prevent late
responses/liveQuery emissions from restoring disposed data. Offline state queues
retain original reader/workspace context. Saved flags confer no offline private
archive right. Cache retention/offline display policy remains a WP0 decision.

Bound per-source polling, global concurrency, paging, bytes/time, retries and
cancellation as in the canonical proposed limits. One source outage leaves other
sources and Tower sync usable. Display last success, stale/error status, and
retry behavior. Item edits upsert stable IDs and preserve flags. Missing older
items in a bounded page are not deletion. RSS weak-ID fallback must disclose its
mapping limitations. HTML is sanitized, plain fields escaped, XML external entities
and network resolution disabled. No active embeds or automatic remote resources.

## Transport and unresolved product choices

HTTPS requires actual allowed-origin Authorization preflight and signer ACL proof.
Disable authenticated redirects; never forward credentials to item links or media.
Selected FIPS uses consented endpoint/peer handles and fails closed without public
fallback. Feed signing/graph forwarding over FIPS requires WP0 proof, not a new
architecture invented by the reader. See [FIPS transport](../fips-transport.md).

Proposed unsubscribe stops fetch, clears private bodies and retains Tower flags
and identity for resubscribe. Retention/forget, mark-unread and field conflict policy
are not agreed. Do not implement silent last-writer-wins or stale replay resurrection.
A1 is a conditional public transport dependency, never a private-feed proxy.

## Acceptance and cutover

F1 needs WP0 + T1 + W1 fixtures; F2 may start on agreed fixtures, live integration
waits for W1. Test two readers and two clients: discovery across connections,
subscribe deduplication, cross-device state, stale conflicts/reconnect, account
switch/revocation mid-fetch, malicious feeds, pagination and source outage isolation.
Verify no destination network traffic before click and exactly one open per click;
refresh, hover and state writes must not visit it. Public RSS/JSON/podcast, mobile,
desktop, browser and WMapp/FIPS must be covered before claiming full support.

M1 compares old/new Book of Sand cards without displaying both, maps reliable
historical external IDs to item state and reports gaps, preserves old rows and
rollback. A real edition must complete with publication disabled, exactly one
source card and intact history. Do not seed other readers or remove unrelated
publisher UI/APIs/grants. R1 later records source hashes, absolute build number,
served `version.json`, managed activation evidence and rollback; UI changes require
`PLAYWRIGHT_DISABLE_VIDEO=1 bun run test:e2e:perf` and observed baseline numbers.
No browser flow changed in this documentation job; these runtime tests remain
implementation acceptance, not claims of validation already passed.

See [Tower state](../../../tower/docs/design/wapp-feed-state-proposed.md),
[Autopilot transport](../../../autopilot/docs/wapp-feed-transport-proposed.md), and
[Book of Sand companion index](../../../tower/docs/contract/wapp-feed-v1-proposed.md#authority-and-review-basis).
The canonical index resolves its app-repository path without copying private
agent-directory labels into Flight Deck public source.
