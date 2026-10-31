# Nostr profile retention and recovery

The browser retains last-known public kind-0 names and avatars in the existing
same-origin `wingman-fd-shared` Dexie database. Age controls refresh, never deletion.
`profiles` stores metadata and event version; `address_book` supplies reactive
labels and avatars through the existing shared live query. Neither table grants
membership or permission. Workspace actors remain the authority for mention
eligibility, actor kind and workspace-specific display names.

`profile-identity.js` canonicalizes decodable hex and npub identities to npub.
Legacy hex profile rows remain readable and are merged without deletion. Signed
event timestamps are compared in seconds independently of local cache timestamps
in milliseconds. The latest signed version wins, while empty/missing fields retain
usable previous values. An explicit newer usable name replaces older name aliases.
Malformed metadata, wrong authors/kinds, future events and invalid signatures do
not replace saved data. Browser image failure continues to use the existing exact
URL fallback; this cache persists avatar URLs, not offline image bytes.

The UI resolver hydrates saved profiles before waiting for relay results and
replaces reactive name state when a result arrives. It enqueues work; it opens no
relay sockets. `profile-worker.js` runs the existing public-relay kind-0 lookup,
validation and durable cache writes. Client and worker coalesce canonical identities
and bound concurrency to four identities. A request deadline starts on dispatch,
not while it waits for a slot. Relay connection and end-of-response waits each have a 1.2-second bound, inside
a four-second outer deadline. A stalled relay cannot discard replies from healthy
relays. Successful
cache writes are fresh for an hour. Misses/failures have a durable one-minute
cooldown, independent of membership's 24-hour reconciliation. The existing visible
background sync cadence rotates through 20 known identities, so another render is
not necessary to recover a miss. Manual profile refresh preserves current names.
A browser without Worker support retains cached display data without falling back
to main-thread network requests.

Workspace switches reset workspace-key display aliases and advance a generation.
Delayed alias reads, profile hydration and relay callbacks cannot update the new
workspace's UI. Public kind-0 data may still be saved in the existing shared public
cache. No workspace records, cursors or membership are copied across workspaces.
Sparse member payloads retain good stored fields; an explicit workspace actor name
has display precedence. The address book is already shared between workspaces in
one origin; this change does not widen that boundary.

## Existing sharing and native boundary

IndexedDB is shared by same-origin browser tabs, including the existing Dexie live
query notifications. It is not shared across web origins, browser profiles, native
application containers or devices. Tower supplies workspace actors, membership and
actor sidecars through its existing authorized APIs. Those are workspace identity
projections, not a global durable public kind-0 relay cache. This web repair adds no
Tower endpoint, shared schema, public profile publication or native synchronization.

Swift and Android follow-ups should inspect their actual persisted profile stores,
identifier keys, event validation/version ordering, retention, negative retry,
workspace-key aliases and UI invalidation before adopting changes. Retain last-known
usable fields offline and move relay work off UI threads. Keep membership eligibility
separate from public identity enrichment. Cross-app/device profile sharing would
need an explicitly reviewed authorized cache contract, including provenance,
privacy, event freshness and stale-response ordering; it cannot be inferred from
this browser-local shared database. Return that boundary to the owning manager
before changing Tower or another repository.

## Regression evidence

`profiles.test.js` uses real Dexie/fake-indexeddb and signed kind-0 events for
retention, identity equivalence, sparse merges, version validation and retry.
`profile-ui-recovery.test.js` covers delayed hydration, immediate name replacement,
failed refresh retention and workspace-generation fencing. The browser fixture
`profile-cache-recovery.spec.cjs` runs the built UI and real profile worker with
intercepted relay events and IndexedDB, then reloads with the real network offline.
These fixtures do not establish real-user relay availability or Tower authorization.
