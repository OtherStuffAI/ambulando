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

First v2 adoption retains v1 downloads and local writes while the replacement
snapshot and delta handover retire old canonical authority. Same-cache reset/history loss/client expiry
and membership revocation invalidate authority and checkpoint identity while
retaining downloaded rows and drafts. Recovery snapshot omissions retire old
canonical authority, not those downloaded projections or pending commands.
Explicit newer tombstones still delete records. Switching viewer/backend remains
a separate cache-isolation boundary; it is not a permission-repair operation.
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

## Negotiated finite snapshot handover

When authenticated discovery advertises `record_sync.extensions` containing
`bounded_snapshot_v1`, the service repeats `extension=bounded_snapshot_v1` on
every v2 page. Registration and acknowledgements retain their existing v2 shape.
The worker validates and persists `handover` (`target_position`,
`through_position`, `complete`, `authority_epoch`, `access_revision`) with the
page cursor and ack intent. A terminal delta needs a complete certificate through
the target; incomplete snapshot/catchup pages cannot certify convergence. An
active non-null target cannot change for ordinary writes. A newer access revision
can extend it for authority-gain repair, as specified by Tower; it cannot regress.
Positions are decimal
strings compared with BigInt; cursors remain opaque. A saved negotiated extension
cannot silently downgrade when later discovery stops advertising it.

This certifies a convergent committed prefix with drained authority catchups,
not a frozen historical export or permission to read retained downloads. Newer
writes can be collected in the next finite round without prolonging this one.
Authority churn may require additional repair catchups before certification.
Unextended v2 retains its existing terminal-delta semantics.

The complete JSON bound includes actor, access and extension metadata, and the
200-entry bound includes changes, actors, access changes and manifests. Tower's
schema/write inventory permits oversized rows and actor labels, so Flight Deck
selects `large_records=chunked_v1` only when both extensions are advertised.
Unnegotiated manifests still fail closed. Oversized records on older servers
remain an explicit 413/incomplete condition.

`pg-large-records.js` runs inside the existing materialisation worker. One
assembly per physical cache stores at most 64 MiB of chunks in Dexie's existing
`sync_state` table, with seven-day local expiry. Each signed chunk is at most
256 KiB. The worker checks manifest/row identity, exact length, SHA256 and valid
UTF-8 before applying the canonical row and actor sidecars. It commits receipts
with the cursor/ack intent and deletes temporary chunks in that transaction.
Portable worker hashing also supports native HTTP contexts without SubtleCrypto.
Retry/reload discards unfinished assembly and requests from the prior committed
cursor; already committed receipt intents survive reload and lost ack responses.
Changed sources and manifest checkpoint conflicts trigger scoped repair while
retaining downloads. No diagnostic server cursor replaces local materialisation.

64 MiB is a client storage budget, not a server write limit. Larger records,
quota failures, bad digests or interrupted transfers remain incomplete and
never advance the checkpoint or emit completion. Universal traversal of every
PostgreSQL-legal individual record is not claimed. Source tests do not prove
deployed discovery, live authority races, slow-link deadlines or HTTPS/FIPS
activation.

Compatibility fixtures: `tests/fixtures/tower-record-delta-v1.json` mirrors
Tower's current canonical fixture (including feed families), with its FIPS peer
identity replaced by an approved synthetic public-source identity. No record or
transport shape changes. `tests/fixtures/flightdeck-bounded-snapshot-v1.json`
provides pending/complete handover examples above Number.MAX_SAFE_INTEGER for
reuse by other consumers. The checkpoint suite combines these contracts with
lost acknowledgements, interrupted retirement, empty progress, access catchup,
revocation/re-grant, concurrent tombstones and stale upsert scenarios.
`tests/fixtures/tower-bounded-record-snapshots-v1.json` is generated from Tower's
`bounded-record-snapshots-v1.ts`: the large body is represented by its repeat
recipe to avoid committing a duplicate 1.2 MB payload. The materialisation test
recreates the exact bytes and consumes Tower's pinned digest/manifest and exact
expected acknowledgement. Full-scale database fixtures and live slow-link
acceptance remain Tower and cross-component validation responsibilities.
