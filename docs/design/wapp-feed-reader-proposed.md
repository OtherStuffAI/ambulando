# Flight Deck subscribed feed reader

Status: **implemented in source; integrated human acceptance remains pending**. Companion to canonical
[`wapp-feed-v1-proposed`, revision `1`](../../../tower/docs/contract/wapp-feed-v1-proposed.md).
The proposed baseline remains unchanged. Tower owns the selected
[actual T1 wire profile](../../../tower/docs/contract/wapp-feed-t1-api.md), including
the Book of Sand graph-signature extension; this companion does not redefine it.
Source tests do not attest deployed endpoints or an integrated release.

## Reader and discovery

Feed has explicit **Legacy** and **Subscribed** views. Legacy is the initial view;
existing publisher, grants, records and flags remain available and unchanged.
There is no subscription seeding, historical conversion or automatic combined
legacy/source card list. Feed + discovers authorised installations across shared
Tower PG Autopilot connections using the existing `/api/wapps` registry, signs
`/feed/list` as the actual reader, and subscribes to a permitted feed through Tower.

The reader uses the canonical `currentWorkspace.pgMe.actor` from Tower’s
actual-reader `/me` response. Its npub must match the active session and cached
workspace signer; mismatched workspace responses are rejected. A missing actor
triggers a coalesced actual-reader `/me` request before feed hydration or UI work,
with generation/backend/workspace/session guards and retry after failure. The
record worker receives the same actor metadata, so cache partitions, SSE and
record deltas agree. Workspace-owner and workspace-key identities are never used
as reader substitutes.

The picker uses shared `autopilot_connections` rows from Agents. If the local
connection cache is empty, it requests the existing service-owned workspace
bootstrap before discovery. Device transport preferences are per connection and
reader/workspace/backend. On first use ordinary browsers select registered HTTPS;
a supported native FIPS client selects FIPS. A saved FIPS selection never falls
back to HTTPS. The visible connection selector lets the reader explicitly change
that choice. FIPS registry discovery uses the existing endpoint/peer-pinned
Autopilot adapter and exact reader signing of `/api/wapps`.

The registry currently exposes a WApp `launchUrl` but no authoritative WApp mesh
endpoint and peer binding. FIPS feed loading therefore reports a recoverable
prerequisite instead of guessing a mesh port or using HTTPS. Platform work must
advertise and bind the WApp feed mesh destination and support exact intended-URL
reader and graph signatures before this can be implemented safely. Path-mounted
feed bases remain unsupported. Each private refresh re-resolves the registry;
observed connection changes/removal invalidate the source.

HTTPS discovery requires the Autopilot registry to permit unsigned browser
OPTIONS preflight and return CORS headers on signed GET/error responses for the
Flight Deck origin. Book of Sand independently needs the exact origin in
`BOOK_OF_SAND_FEED_CORS_ORIGINS`. Runtime CORS/ACL failures cannot be repaired by
reader actor initialization or restarting Flight Deck.

The registry publisher `appNpub` must not be assumed to identify a separate
existing graph corpus. A source with a distinct graph identity uses the explicit
Tower launcher feed binding described below; clients validate that binding before signing. Do not rotate a publisher or accept
arbitrary bootstrap identities to work around a mismatch. Graph targets must
use the reader’s selected logical Tower origin. Book of Sand supports
`BOOK_OF_SAND_FEED_TOWER_URL` for that public signing/forwarding origin, preserving
its unrelated legacy `TOWER_URL` publishing paths.

Manual Book of Sand links accept the registered home URL, `/feed/`, or
`/feed/editions` without query/fragment. Flight Deck resolves them from Tower
personal-WApp launcher metadata through the existing workspace bootstrap and Dexie,
independently of Autopilot registry availability. A launcher `metadata.feed_binding`
pins `protocol: book-of-sand-v1`, the verified `installation_id`, the shared
`autopilot_connection_id`, and `graph_source_app_npub`. The launcher supplies the
registered root origin and app ID; an ambiguous, archived or missing binding fails
visibly. Publishing that configuration uses existing Tower launcher permissions,
not a feed bootstrap's self-declared identity. No new Tower source kind is added.

Manual validation signs Book of Sand's bootstrap and list as the actual reader,
checks the graph origin/owner/source/group/query bounds, and saves the standard
Tower WApp tuple only when Editions is readable. Reload resolves the same Tower
pin and reauthenticates the source without requiring `/api/wapps`. Binding removal
or change invalidates cached private bodies; a formerly pinned source cannot
quietly switch to registry-derived authority. Connected browsing still lists the
authorized registry and checks its origin/app/installation against any Tower pin.
The independent graph pin distinguishes an existing corpus from its publisher.
The manual button remains usable while registry discovery is pending or failed.

Public URLs accept JSON Feed 1.1 or RSS/podcast feeds through direct browser CORS,
with no reader credentials, cookies or public proxy. The user selects the format.
A network/CORS failure is surfaced per source; universal no-CORS support is not
claimed. All automatic redirects are rejected conservatively, including public
redirects. URL serialization removes the source fragment while preserving queries.

Cards show source, title, text, date and podcast attachment metadata. Only a
deliberate headline click opens the exact safe source-provided URL once, with
`noopener,noreferrer`. Ingestion, hover, refresh and flag writes never visit the
destination. Attachments neither load nor autoplay. Read/unread, dismiss/restore
and save/unsave are personal flags, independent of WApp effects and access.

## State and content ownership

State path: **TowerSyncService → Dexie → liveQuery → Alpine**. The existing service
owns typed feed-reader hydration and named subscription/state commands, request
coalescing, workspace disposal, SSE and record-delta recovery. Feed subscription
and item-state families register in the central PG registry and materialization
worker. SSE payloads update their Dexie rows directly; no component polling or
second Tower network owner is introduced. Older Tower record pages without these
additive families remain readable; subscribing requires T1 endpoints.

Dexie version 30 adds reader subscriptions, item states, source bodies/status,
original-partition offline state intents and device transport preferences. The
upgrade is additive and copies no legacy Feed rows. Transport rows, local rows and
rendered projections remain separate. Partitions include logical Tower backend,
workspace, actual reader actor, subscription and structured source tuple.

State commands send explicit field patches, expected row version and mutation UUID.
Only on an authoritative HTTP 409 `state_conflict` the descriptor reloads and
reapplies only intentional fields with a fresh UUID, bounded to three attempts;
mark-unread remains explicit false. Changed mutation-ID reuse and other 409 errors fail without hydration or a new UUID.
The API adapter preserves T1 nested error code/message/retryable fields and legacy
top-level errors. Exhausting three writes fails without an unused fourth mutation.
Newer materialized versions win over old acknowledgements.
Offline intents stay in their original partition and are replayed only by the
service-owned recovery/hydration path after authentication. Unsubscribe blocks
replay, cancels source fetch and purges private bodies. Tower retains subscription
identity/flags indefinitely for this initial implementation; resubscribe is an
explicit versioned PATCH. There is no forget feature or private saved-body archive.

Source fetching has an independent lifecycle and worker parser. It coalesces one
refresh per source, bounds concurrent source jobs to four, times each resolution
and page at ten seconds, limits decompressed pages to 2 MiB, and refreshes at most
five pages/500 items. Page URLs are visited once and WApp pagination stays on the
registered origin/feed path with cursor/limit query only. Cross-page repeated IDs
are deduplicated; duplicate IDs within one page are errors. Edited IDs upsert and
retain flags. Missing items in a bounded page do not imply deletion. Each source
cache is bounded to 500 bodies; Tower state remains independent of local eviction.

Polling is five minutes with jitter; failures back off exponentially to one hour
and respect bounded numeric Retry-After. A source outage leaves other sources and
Tower sync usable. Status records show last attempt/success, stale/error and retry.
Private bodies expire after ten minutes with a thirty-second cleanup cadence and
are purged at every reader activation: they are not an indefinite offline archive.
Public source content is retained in its reader partition until evicted.

Logout, workspace/account replacement, page exit, detected signer unavailability,
explicit reader lock and 401/403/404 or registry revocation dispose/deny source work
and purge private bodies. Generation/abort guards reject late fetch, parse, command
and live-query results. Browser extensions do not expose a universal immediate
wallet-lock signal: a lock is observed through the existing signer availability
watch or a signing rejection; native wallet-lock delivery remains an integration
proof. A transport grant never authenticates a feed reader.

## Book of Sand reader signatures

The selected W1 adapter signs `/api/feed/read-targets` as the actual reader, then
validates the fixed graph URLs against the selected Tower endpoint, workspace owner,
registry app identity, locally visible group and a read-only query allowlist.
Story/Reference labels, limit 200 and offset 0 are enforced. Each list/feed page
carries separate fresh signatures for the WApp URL and both exact graph URLs in
W1's `X-Tower-Stories-Authorization` and `X-Tower-History-Authorization` headers.
No owner parameter, cookie or app/bot credential substitutes for the reader.
Graph source/run filters may narrow the fixed configured projection. W1 independently
verifies and forwards the graph signatures; Tower RLS remains authoritative.

W1 currently projects a bounded recent window of 200 Story + 200 Reference rows.
Full historical coverage, actual human browser CORS/ACL proof and FIPS/WMapp feed
signing remain platform dependencies. Allowed browser origins need separate
runtime configuration during an authorised activation. Missing endpoint, app
identity or graph-group binding fails closed rather than inventing metadata.

## Parsing and validation

JSON types, stable IDs, dates, URLs and attachment metadata are bounded/validated.
HTML is reduced to inert text rather than inserted into the document, preventing
active embeds, handlers and remote-resource loading. The worker-safe RSS tokenizer
rejects DTDs, external/unknown entities, XInclude, malformed XML and excessive
depth/element counts. RSS identity requires a nonempty GUID or safe absolute item
link; feeds without either report `rss_stable_id_required`. A weak content fingerprint
is deliberately unsupported rather than claiming reliable historical state mapping.

`tests/feed-reader.test.js` covers isolation, parsing, paging, denial/cancellation,
CAS/offline state, record-delta and SSE. `tests/feed-api.test.js` exercises the real
browser T1 request adapter, exact routes and reader signing. For a reviewed W1
checkout, run the actual-handler source probe without a server:

```bash
FEED_WAPP_SOURCE_MODULE=/path/to/book-of-sand/src/feed.ts bun run test:feed:wire
```

The probe uses synthetic ephemeral test identities and checks separate same-reader
graph signatures, exact headline, denial purge and zero destination requests.
Browser fixtures cover desktop/mobile reader controls and deliberate link opening;
performance validation follows [the baseline](../playwright-performance-baseline.md).
Real two-client Tower/browser convergence, actual human CORS/ACL and native lock/FIPS
proof still belong to integration validation; mocked tests do not claim them.

A1 (public proxy), M1 (historical migration/publisher removal) and R1 (integrated
release/activation) remain excluded. See the [service contract](tower-sync-service.md)
and [FIPS transport](../fips-transport.md).

## Joint Feed/workspace release check

After changes to Feed, reader identity, worker payloads, SSE hydration or snapshot
retirement, run the existing suites together against the configured managed
Flight Deck runtime:

```bash
PLAYWRIGHT_BASE_URL=http://127.0.0.1:<managed-flight-deck-port> \
PLAYWRIGHT_BROWSER_CHANNEL=chrome PLAYWRIGHT_DISABLE_VIDEO=1 bun run test:feed:sync
```

Set the managed runtime URL explicitly; omitting it starts Playwright's Vite
server. The native transaction fixtures intercept loopback probe URLs and use
real IndexedDB/materialization workers, without contacting a Tower. Keep the
Playwright Tower default local; external backend tests require the explicit
URL and exact acknowledgement enforced by `playwright.config.cjs`.

The check combines source parsing/CAS/isolation and API tests with SSE commit
ordering, worker lifecycle, existing populated-cache/pending-write recovery,
expired cursor, actual Alpine reactive nested identity/permissions/harness
inputs, interrupted replacement, repeated multipage catchup, stale optional
400 targets beside valid messages, malformed Feed events, preserved Feed
history, and reader/workspace replacement. Desktop/mobile reader fixtures
exercise deliberate navigation and flag controls. These are deterministic
regressions, not authenticated human acceptance.

For release, also run the repository's full source/release/build/dist checks.
Use the final compiled managed app and its served worker for a browser check,
verify served version/assets/health, and validate reproduced stale targets
read-only with the current capability broker. If UI behavior changed, run the
performance baseline and compare actual measurements. Report browser, cache
starting state, signing identity and any untested human Firefox/service-worker
adoption explicitly. A fresh-cache success does not prove existing-cache repair.
