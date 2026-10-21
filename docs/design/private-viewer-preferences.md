# Private viewer preferences

The Nostr viewer base URL is a private setting for the authenticated Tower actor
in the selected workspace. Tower owns the saved value; devices materialize it in
Dexie and Alpine observes that local projection through `liveQuery`.

Tower's additive `GET/PUT /api/v4/flightdeck-pg/workspaces/:workspaceId/me/preferences/:key`
contract stores bounded scalar strings, with `expected_row_version`, immutable
`mutation_id` retries and optional insert-only imports. It never interprets URLs.
The Ambulando key is `ambulando.nostr-viewer`. The signed-in actor is selected by
authentication, never by a request body or a selected workspace-owner identity.
The cache context includes backend, app, workspace and authenticated actor.

`TowerSyncService` owns requests, coalescing, private SSE refreshes and existing
workspace pull/fallback/reconnect recovery. The materialization worker commits
canonical values and reconciles immutable pending writes in `private_preferences`.
A save enqueues local intent atomically; `liveQuery` projects the last pending
choice until acknowledged. Offline requests retain the same mutation ID. A CAS
conflict discards that stale intent and its dependent writes, reads authority,
and asks the user to save again if desired. It never silently rebases stale intent.
A transport failure does not authorize cache erasure. No separate timer or SSE
connection is created for preferences.

A first save requires one successful private read. Legacy browser-local values
are never displayed or adopted ahead of that read. The first authenticated
context claims the old unscoped browser setting; other actors/workspaces cannot
import it. Adoption is insert-only at Tower, so another device's existing choice
or explicit reset always wins. A default is an explicit saved value rather than
a deleted row. Unsupported older Towers retain the legacy data for later adoption
and reject first saves with a connection message; they do not claim cross-device
synchronization or fall back to shared workspace settings.

Ambulando validates absolute HTTP(S) viewer URLs, rejects credentials, queries,
fragments, whitespace and backslashes, preserves path prefixes and normalizes
trailing slashes. Blank/reset saves `https://njump.me/`. Cached njump links are
rewritten when opened, preserving their Nostr identifier and leaving unrelated
links unchanged. Canopy's supplied event prefix is
`https://canopy.winn.cloud/event/`; URL routing policy stays in the client.

Validation consists of signed API/Postgres contract tests in Tower, independent
Dexie/store convergence tests with explicitly simulated transport, and a
Playwright two-context flow with simulated HTTP responses and real signing,
production service, worker, IndexedDB and live projection. A simulated browser
pass does not establish hosted authenticated cross-device activation.
