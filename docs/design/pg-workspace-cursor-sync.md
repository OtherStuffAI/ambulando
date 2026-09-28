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

The negotiated record-delta v1 path stages snapshot pages and their delta
handover under private, viewer-keyed `sync_state` rows. Download cursors advance
with staging commits; existing view tables remain visible. The terminal delta
page publishes all staged changes, omission retirement, and the active cursor
in one workspace transaction in the materialization worker. An empty delta
handover may reuse the terminal snapshot cursor; staging keys use page order
rather than cursor tokens. Failed publication rolls back the entire replacement.
Interrupted downloads resume from persisted staging without blanking the cache.

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
