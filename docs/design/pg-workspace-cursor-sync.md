# PG Workspace Cursor Sync

Tower PG workspaces synchronize through the bundled Tower endpoint documented
in `wingman-tower/docs/design/flightdeck_pg_workspace_sync.md`.

Flight Deck persists an opaque cursor in the workspace Dexie `sync_state`
table under a workspace-and-viewer-specific key. A missing cursor starts a
bounded snapshot. Snapshot pages carry opaque Tower cursors and are applied
incrementally until `snapshot_complete` is true. Subsequent manual, background,
and SSE-triggered refreshes send the terminal event cursor and receive only
affected channel bundles and typed tombstones.

The cursor and snapshot seen-manifest are saved inside the same Dexie
transaction that applies each bundle. They must never advance before the
materialized rows commit. Intermediate snapshot pages only upsert; omission
reconciliation is deferred until the terminal authoritative boundary. A retry
therefore resumes from the committed opaque cursor without clearing browser
storage, and replaying a page is idempotent.

Each sync request has a 30-second abort timeout. A timeout leaves the committed
cursor and manifest intact, surfaces the retryable `Update stalled` state, and
never leaves `Receiving changes...` active indefinitely.

The browser no longer performs a full synchronization by walking scopes,
channels, threads, messages, tasks, comments, documents, and media through
separately signed requests. Those list endpoints remain available for explicit
navigation and targeted reads.

## Record-delta replacement continuity

The negotiated record-delta v1 path publishes authorized snapshot upserts
progressively in the materialization worker. Each transaction applies at most
32 changes with canonical rows, projections, and a durable subpage checkpoint.
The opaque download cursor advances only with the last subpage. An interruption
replays the same server page; committed canonical versions make its prefix
idempotent. Unseen cached rows remain visible during download and retry.

The terminal delta handover authorizes one omission walk in 32-row transactions.
Each transaction stores its continuation with the retired rows and recovery
conflicts. The terminal cursor advances and the reconciliation marker is consumed
only after all checkpoints complete. Reload finishes a persisted retirement
before making another network request. Typed tombstones apply in their subpage;
only omission waits for the completed snapshot/handover. This replaces the
build-2100 private staging/all-table replay; interrupted old staging triggers
one preserved-view snapshot recovery rather than replaying it wholesale.

A `409 reset_required` invalidates the download cursor and increments the local
authority generation. It discards staging, preserves view rows, and starts a new
snapshot. Generic 401/403, transport failures, malformed pages, and missing
endpoints are not revocation evidence. A typed `workspace_membership_required`
403 immediately hides authority while preserving recoverable commands outside
view tables. Resource visibility loss is reconciled at the complete authorized
snapshot/handover; explicit delta tombstones apply immediately. Omitted pending
edits to previously authorized canonical records are retained as recovery
conflicts, with their outbox intact, rather than shown without authority.

Scope/channel collection reads require valid arrays and row identities, reject
pagination and potentially capped lists, and verify workspace identity before
accepting an empty response. Scope and message commits, like channel commits,
reject changed workspace/actor activation or newer cursor/generation authority.
Bounded message reads only merge rows; omission cannot clear cached history.
Malformed transcript pages cannot replace conversation membership with an empty
list. List hydration remains a TowerSyncService port, never a component fetch.

The legacy bundled-sync rollback path retains its existing incremental snapshot
upserts and terminal omission reconciliation. Complete nonpaged replacements
already commit atomically; malformed scope/channel/message snapshot collections
are rejected before reconciliation. No Tower epoch or wire contract changes are
required: actor-bound cursors, snapshot partitions, and terminal delta handover
provide the replacement authority boundary.

### One-time snapshot retirement and upgrade recovery (build 2117)

Snapshot omission retirement is authorized by `snapshotReconciliationPending`,
set during snapshot staging/application and consumed at the terminal delta
handover. `snapshotComplete` is historical information; `converged` describes
current pagination. Neither their combination nor an ordinary delta's terminal
page authorizes a second omission walk. Typed reads can replace presentation
rows without journal generation tags, so repeating that walk erased authorized
navigation and chat even while their canonical rows remained cached.

Pre-fix completed snapshot states lack the new marker. Their first sync resets
only the download cursor/staging with a generation compare-and-swap, preserves
visible rows and local intent, and downloads one fresh authorized replacement.
This restores already-erased views whose retained canonical versions would
otherwise suppress equal-version replay. Persisted new staging carries the
marker, so interruption after snapshot completion resumes its delta handover.
Subsequent ordinary deltas keep the cursor and do not repeat upgrade recovery.
Tombstones still apply immediately; confirmed replacement omission and typed
membership revocation retain their existing reconciliation behavior.

## Workspace isolation

PG selection and Dexie keys include the verified Tower service, workspace
service, app, signer and workspace UUID. Owner identity and display labels do
not distinguish workspaces. Restoring an older key is allowed only when one
saved workspace matches it; ambiguous owner-only selections must not choose a
workspace implicitly.

Switching opens the destination partition and resets rendered collections; it
must not clear records, pending writes or cursors. Reads retain a workspace and
activation-generation snapshot and reject persistence after a switch. Live
subscriptions likewise ignore callbacks from an earlier activation. Existing
materialization-worker disposal remains the physical boundary for bundled sync.

Old keys without UUIDs are not trusted as data partitions: their databases are
retained untouched and the UUID-qualified partition starts a fresh Tower sync.
This avoids copying potentially mixed records to another workspace. Unsynced
rows in an old ambiguous partition require explicit attribution before recovery;
the client does not automatically copy or delete them.

### Upgrade recovery notice (build 1888)

On every PG workspace activation, including restored selection on startup, a
short-lived worker checks the pre-UUID database name for the selected
Tower/workspace-service/app/signer identity, plus its signer-less variant. It
opens only existing databases with their existing schema and uses read-only
transactions. No records, schema versions, cursors or queues are changed. The
selected UUID partition continues its independent normal sync.

A nonempty `pending_writes` or `document_drafts` table, any row with
`sync_status` pending/failed, or `pg_reconciliation_pending: true` triggers a
**Local edit recovery** section in the avatar menu. Expand it for recovery
steps and device-local choices. A clean cache produces no banner.
An inspection failure, unavailable worker or 30-second timeout produces a
could-not-check recovery notice; it is never treated as a clean cache. Checks
run off the main thread, and late results from an earlier activation are
ignored. Repeated startup checks do not acknowledge or consume anything.

This is detection and manual recovery, not automatic migration. Even when a
command contains an exact UUID, other rows in the same old database may be
mixed. The last sync identity alone cannot establish the provenance of every
row. Both workspaces sharing an old key therefore show the warning, without
rendering legacy record contents in either workspace. Legacy commands are
never imported into an active outbox or passed to a flush worker.

Recovery path for an administrator assisting the browser owner:

1. Keep the original browser profile and site storage. Close older Flight Deck
   tabs so an old client cannot continue writing or sending from the shared
   cache. Do not clear site data, delete databases or downgrade as a recovery
   shortcut.
2. Back up the browser profile with the browser closed before investigating.
   In that same browser profile/origin, inspect IndexedDB in developer tools.
   Candidate names are `wingman-fd-ws-` followed by the selected `pg:` identity
   with its final `::id:<workspace UUID>` removed, and the same name without the
   signer prefix. Preserve all tables, including outbox, drafts and sync state.
3. Review the pending writes, protected rows and drafts against the intended
   Tower workspace UUID and current remote record. An exact command/draft UUID
   is useful evidence for that item; service, owner, label and last sync
   identity are insufficient to assign all rows. Leave unattributed items
   untouched. Do not replay a whole outbox or copy a whole cache.
4. Recover each confirmed edit through the normal editor in its verified
   workspace, reconciling newer remote changes and normal access/checkout
   requirements. Confirm the edit has synced. Retain the original backup.
   Any selective archival/removal of recovered legacy items requires the
   browser owner's explicit approval; this client does not perform it.
5. Reload or reselect the workspace to recheck. The menu entry remains while protected legacy data remains unless the owner
   chooses Tower for that workspace. Dismiss keeps it collapsed across reloads.

Limitations: there is no in-app export, attribution, replay, or acknowledgement
workflow. Saved document drafts are conservatively flagged even if already
recovered. This checks the two pre-fix PG key formats, not arbitrary renamed
IndexedDB databases, other origins/profiles, or legacy localStorage drafts.
Runtime/browser review must verify the worker under the deployed CSP, banner
readability on desktop/mobile, repeat reload, same-service switching and a
clean-cache startup. Unit coverage uses real Dexie with fake IndexedDB; it does
not replace an actual browser recovery rehearsal.

### Navigation hydration ordering (build 1890)

The channel-list hydrator must not use the rendered Alpine scope collection as
an authoritative scope manifest. Scope reads commit to Dexie before `liveQuery`
delivers them, and a repeated family refresh can return a freshness marker
instead of rows. Treating that interval as an empty workspace erased cached
channels during startup.

Channel-list hydration now reads Tower's scope list directly, gathers all
channel lists, then replaces channels in one workspace transaction. Existing
same-workspace channels remain visible throughout the read. Failed, malformed,
or potentially capped list responses leave the cache intact; bounded workspace
sync remains the reconciliation path for collections reaching the list limit.
Successful empty lists still reconcile removals. The commit rejects changed
workspace activations and changed record-delta authority (cursor, reset state,
or local generation), so a delayed list cannot undo a newer revocation/reset.
Explicit unreadable channel rows are hidden even without a version change.

Opening home in an already-loaded workspace preserves its rendered collections.
Different-workspace activation and unproven preselected runtime state still
reset them. No legacy cache is copied and no new authorization cache is created.

### Device-local recovery choices

Recovery notices live in the avatar menu, never in a fixed page overlay.
**Dismiss** collapses the notice and persists that preference for the current
workspace key (including its signer and UUID) on this browser only. The entry
can still be expanded to review or resolve it.

**Use Tower’s version** performs the normal PG full pull into the canonical
workspace partition, then records that the owner has chosen not to recover the
older drafts for this workspace on this device. It does not import or replay
legacy pending commands, erase shared legacy databases, change other workspace
preferences, or discard newer edits in the canonical partition. Original old
caches remain a fallback. The notice is retired only after a successful Tower
refresh and preference write; failed refreshes remain retryable. Stale inspection
results and completions from an earlier workspace activation cannot override the
choice or affect a newly selected workspace.

## Bounded snapshot application and targeted reads

Snapshot generation includes the local reset generation, so equal-version rows
restore after a reset even if a server reuses its snapshot identifier. Old
canonical rows and actor sidecars are retained during download, then retired at
the completed handover. Pending edits and commands keep their conflict recovery
semantics. A pending unacknowledged local create remains visible; an omitted
previously authorized edit moves to recovery with its outbox intact.

Navigation and transcript reads remain usable while a snapshot downloads.
Navigation tokens bind reset generation, snapshot identity, command revision,
and retirement phase rather than every advancing download cursor. Materializers
check canonical tombstones and newer entity versions before merging. Authorized
reads during a snapshot retain its generation tag; omission also consults
canonical membership so a typed view replacement cannot erase a seen row.
Changed workspace/actor activation, reset or handover phase rejects a stale
completion. Ordinary incremental deltas retain their cursor guards.

Targeted transcript work can take an IndexedDB turn between bounded snapshot
transactions instead of waiting behind the full retirement queue. Its commit
checks generation, authority token, lineage, canonical versions and tombstones.
History readiness no longer waits for optional activity/session-health recovery;
those families retain their own coalescing, recovery errors and background retry.
The worker client reports a still-pending operation after ten seconds without
acknowledging, cancelling or starting a second transaction. Worker responses
include operation duration for diagnostics. Summary backfill also uses 32-row
transactions and resets its continuation when authority resets.

Regression coverage includes page/subpage interruption and replay, resumed
retirement before network continuation, legacy staging recovery, reset and
same-version restoration, one-time omissions, tombstones, membership revocation,
pending writes, targeted navigation during advancing snapshots, and independent
history readiness. The native browser worker fixture exercises an interrupted
85-page replacement. Device/runtime acceptance still requires a managed-browser
smoke pass; engine replay alone does not establish WM App acceptance.

### Browser validation of bounded application

The real built worker was replayed offline against native Chromium and WebKit
IndexedDB with a saved 86-page authorized sample: 14,292 canonical changes and
183 actor identities. Fresh and populated caches both ended with 8 scopes,
34 channels, 6,451 chat rows, 751 tasks and 253 documents. The sample represents
one viewer's authorization. Network download time and native-shell behavior are
outside this replay.

| Engine/cache | Apply across pages | Terminal handover | Longest concurrent read | History during download / handover |
| --- | ---: | ---: | ---: | ---: |
| Chromium, fresh | 14.23 s | 572 ms | 209 ms | 8 / 5 ms |
| Chromium, populated | 13.54 s | 548 ms | 261 ms | 8 / 5 ms |
| WebKit, fresh | 28.15 s | 658 ms | 586 ms | 56 / 13 ms |
| WebKit, populated | 46.82 s | 609 ms | 738 ms | 55 / 13 ms |

The earlier published Chromium worker blocked reads for 16.43 s and queued
history for 16.61 s at handover. A same-sample WebKit replay of that old source
measured 30.40 s terminal publication, 30.23 s concurrent read blockage and
30.44 s queued history. Bounded publication substantially shortens read/queue
blockage; total populated WebKit application remains a performance limitation.
The total replay including summary backfill was 14.92/14.17 s in Chromium and
28.79/47.46 s in WebKit. Whole-page duration can exceed a second while readers
run between its committed subpages. No WM App acceptance is inferred from the
engine results.

The native worker fixture also passes an interrupted 85-page replacement with
16,802 presentation rows, subsequent explicit deletion, and authorized empty
retirement. Required isolated composer/navigation baseline: exact 74/74
characters, zero typing long tasks, normal/heavy key-to-input p95 0.3/0.7 ms,
key-to-render p95 217.3/136.5 ms, composer readiness 478/766 ms, thread-open
p95 99.9 ms and task-detail-open p95 291.4 ms. The documented September baseline
was 215.6/231.2 ms render p95, 1,022/1,588 ms readiness, 145.8 ms thread open
and 499.8 ms task detail. The normal render difference is small; exact typing,
long-task, heavy rendering, readiness and navigation signals remain healthy.

## Reactive identity and replacement conflict recovery

The worker store snapshot projects reader actor ID, actor npub and workspace ID
into plain scalar objects. It must not retain references to Alpine's nested
reactive `pgMe.actor` or `pgMe.identity`: structured cloning rejects those
Proxies before the worker can run either a normal apply or the preserved-view
reset following `409 reset_required`. A reset failure leaves the saved cursor
unchanged, so every retry can repeat the same 409 and clone error despite
independent typed reads continuing to update the UI. Reader identity validation
still binds the actor to the selected signer and workspace.

Cached-conflict reconciliation is local replay, not a Tower delta handover.
During an incomplete replacement it can reapply acknowledged records already
seen in that generation without changing the cursor or authorizing omission.
Older unseen conflicts wait until Tower sees the record or completes handover;
replaying them early must not promote old membership into the new generation.
Genuine network deltas before snapshot completion remain rejected. Existing
partial caches resume their committed cursor and recovery conflicts without
clearing site data, queued writes or surviving navigation/history.

A real failure remains visible during automatic retries and clears after a
successful workspace pull. Progress changes no longer hide and redisplay the
failure banner on every fast attempt. An explicit Retry starts a new attempt. Failure persistence is scoped to the
workspace/viewer connection; progress or completion from a previous activation
cannot overwrite the selected workspace’s status.

Native IndexedDB regression coverage uses nested JavaScript Proxies at the
actual store projection/worker boundary, old damaged projections with retained
canonical rows, interrupted replacement/reconnect, expired-cursor reset,
retained pending intent, typed list/message refreshes, three repeated four-page
delta catchups and workspace partition switching. Browser-engine fixtures do
not establish acceptance on a particular human signer, browser profile or
native WM App device.

## Optional target failures and additive Feed coverage

SSE hydration waits for all submitted core jobs to settle. Response-activity and
workroom reads and Feed event materialization report optional failures separately,
so a failed hint cannot skip valid message commits or workspace catchup. Only a
400 `resource-not-found` with `required_permission: channel.read`, matching
workspace identity and a response-activity/workroom read is a terminal absent
hint. It does not supply a tombstone or authorize empty target replacement.
The service forces workspace reconciliation before acknowledging that batch,
including when a recent delta would otherwise suppress catchup. Deferred or
failed core reconciliation never acknowledges the batch.

Other validation, authorization and transport failures remain actionable errors
and leave the batch unacknowledged. Three quick retries are followed by retained
work and a 30-second cooldown. A successful background/manual workspace catchup
retries that retained work; context replacement discards it and reload replays
from the worker's durable unacknowledged cursor. Later live work can materialize,
while worker acknowledgement order prevents it skipping a failed earlier batch.

Snapshot omission stores the advertised family coverage. Older Tower snapshots
without additive Feed families cannot retire those subscriptions/item states or
canonical Feed rows. Snapshots advertising those families still authorize their
omissions; explicit Feed tombstones and typed membership revocation still apply.
Cached source bodies are not snapshot families. Their independent source expiry,
denial and reader-disposal policy remains in the Feed lifecycle.

The worker store is a scoped schema projection: actual-reader actor ID/npub,
workspace identity, reader permissions, session npub, cached workspace signer,
logical backend/app, activation generation and harness agent npub/URL arrays.
Nested Alpine Proxies are never forwarded. Malformed scalar identity/permission
fields fail validation, rather than becoming authority through lossy conversion.
Bundle rows originate from transport or explicit plain local reconciliation
payloads; this boundary does not stringify arbitrary application state.
