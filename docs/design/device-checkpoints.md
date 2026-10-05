# Cache-specific record checkpoints

Flight Deck discovers `record_sync` through the authenticated Tower service
route and explicitly requests v2 when `device_checkpoints` and protocol 2 are
advertised. Discovery is shared across pulls for a backend/app/workspace/signer
activation. Absent older-server capability keeps v1; authentication and transport
failures never silently downgrade. A server rollback replaces the v2 generation
through v1 snapshot semantics rather than sending a v2 token to a v1 endpoint.

TowerSyncService retains network/update ownership through its cursor recovery
port in `pg-read-hydrator.js`. `pg-device-checkpoints.js` orchestrates register,
page, acknowledgement, conflict replay and retirement. All persistence uses the
service's existing materialisation worker. Dexie liveQuery remains the UI source.
The Tower contract is `../tower/docs/contract/record-device-checkpoints-v2.md`.

## Identity and cache integrity

The workspace Dexie `sync_state` row stores a random lowercase nonzero UUID,
backend/app/workspace/signer scope, authority epoch, local generation, committed
cursor, revision and pending acknowledgement. A cache-owner row independently
binds this state to its canonical row count. A missing owner or count mismatch
cannot resume a restored cursor: it creates a new cache identity and snapshot.
Switching scope replaces ownership and hides unrelated authority. Whole-cache
cloning is not a supported backup/import operation: a clone must omit checkpoint
identity/owner metadata so its next pull creates an independent registration.

First v2 adoption preserves v1 views and local writes until the replacement
snapshot and delta handover finish. Reset/history loss/client expiry hides old
authority while preserving pending commands and recoverable local edits.
Registrations marked obsolete by this cache are retired only under their matching
signer/backend/workspace scope. Capacity errors retain the new ID and report the
failure; active devices are never enumerated or evicted.

## Commit and acknowledgement ordering

Existing resource bounds remain: at most 32 changes per transaction, with the
server cursor unchanged until the complete wire page commits. Canonical rows,
actor sidecars, projections and subpage checkpoints commit together. A crash
replays the page from the preceding cursor; canonical versions suppress duplicate
prefix work. The final transaction saves the new cursor, issuance revision and
ack intent. Snapshot omission retirement retains its 32-row checkpoints and
moves the cursor/ack intent only in the final handover transaction. Reload resumes
that walk before any new page or acknowledgement.

Only then does the network owner send the exact signed ack body. A lost response
leaves intent durable for an idempotent current-checkpoint retry. Conflicts read
checkpoint metadata but never substitute its cursor; pages replay from the local
committed cursor with a fresh issuance revision until an ack succeeds. An empty
v2 delta page is committed and acknowledged as well, keeping the durable handle
current without repeatedly snapshotting. Tower bounds temporary tokens at 512
per client; Flight Deck does not introduce server-side retention changes.

## Concurrency and transport

The service coalesces recovery requests within a tab. Browser Web Locks serialize
pulls and acknowledgements for the physical IndexedDB cache across tabs. Native
FIPS/HTTP contexts without Web Locks use a worker-owned 120-second Dexie lease,
renewed every 30 seconds. Lease renewal may run between bounded worker chunks;
every materialisation/retirement commit checks its fencing token and expiry.
A suspended or replaced owner cannot commit a late page. A lease owner dying
without release delays takeover by at most the remaining lease lifetime.

Page commits additionally compare generation, client, scope and request cursor.
Workspace disposal prevents late service results from applying to another
workspace. V2 discovery and all checkpoint routes use the session signer so
actor identity does not change when a workspace-key signer becomes available.
Registration hashes and sends the empty string; ack hashes the exact serialized
`{cursor,expected_revision}` body. FIPS transport continues to resolve the exact
logical signing URL through the existing Tower transport adapter.

Automated coverage lives in `tests/pg-device-checkpoints.test.js` and the exact
transport cases in `tests/api-sync-auth.test.js`, alongside the existing bounded
record-delta, hydrator and materialisation-worker suites.
