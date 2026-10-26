# Browser connection recovery

Settings contains the simple Tower connection status and Retry control. Normal
screens do not show the verbose transport badge; cached records, drafts, account
and NStack settings remain available during recovery. The existing SSE and
fallback reachability state remains authoritative for general connectivity. A
failed Inbox view-state read additionally keeps Settings at Connection lost
until a successful view-state snapshot or viewer-scoped view-state event refresh.
An unrelated successful request does not clear that warning.

Only GET requests to the resource-view-states collection retry transient transport
failures and HTTP 408, 429, 502, 503 or 504 responses. There are at most three
attempts, with 300 and 600 ms backoff. Each attempt has the existing 20-second
transport timeout and a newly signed NIP-98 event with fresh content, including
when signing with a delegated workspace key. Signing failures, access failures,
other endpoints and mutations do not enter this retry path.

Online, focus and visible-page recovery request Inbox view-state refresh alongside
existing background sync. These recovery reads do not flush pending read writes.
Concurrent refreshes coalesce; identity, workspace and selected-scope changes or
background-sync teardown cancel obsolete reads. Complete snapshots replace local
view state only while their original scope is current. Failed reads retain the
cached projection and pending local read positions. The record-delta lane keeps
its existing local attention projection and receives its view-state updates via
normal journal/event synchronization.

Request duration, endpoint template, status, failure category and retry stage use
the existing consent-controlled diagnostics capture and allowlist sanitizer.
Report a problem also offers a local JSON export through the existing diagnostics
worker/store. It includes the running build, UTC export time, platform `web` and
bounded sanitized events. Recording off exports no retained history. Export
never includes scope keys, report destinations, descriptions, raw headers,
query values or message bodies, and does not upload or change report consent.

Regression tests cover retries and fresh signatures, cancellation and coalescing,
cache preservation, auth separation, event recovery and consent/redaction. The
browser connection probe uses production code, real IndexedDB and a controlled
loopback transport; it does not establish production backend availability.
