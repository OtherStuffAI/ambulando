# TowerSyncService final command and materialisation contract

Status: stages 1–6 implemented

`TowerSyncService` is the single lifecycle owner for an active PG workspace.
It owns the workspace identity, one SSE owner, one fallback timer, disposal on
workspace replacement, and coalescing keys. Its explicit ports cover initial
hydration, targeted `ensureLoaded(family, id)` reads, cursor recovery, fallback
polling, freshness decisions, and Dexie materialisation.

Stage 2 registers workspace bootstrap, WApp activity, WApp mutes, WApp
publishing grants, and personal WApps as workspace-keyed service families.
The service owns duplicate-request coalescing, family freshness, and disposal
invalidation. Their materialisers write Dexie; personal WApps, activity, mutes,
and publishing grants reach Alpine through existing live queries rather than
Tower response application.

Stage 3 registers scope, channel, task, document, channel-task, and
channel-document collections with workspace-scoped freshness and coverage keys.
Stage 4 registers task/document detail and comments, bounded channel/thread
messages, reactions, daily notes, workrooms, and workroom participants. UI
managers request these families through `ensureLoaded`; the service coalesces
identical targets and rejects late completion after workspace disposal.

Document version-history reads remain deliberately excluded. They are an
explicit, user-opened immutable audit preview with no Dexie materialized table;
moving that route would require defining a persisted version family rather than
silently applying a Tower response to workspace state. Edit leases, application
versions, signer availability, external profiles, storage transfer, and command
acknowledgements remain the documented non-workspace exceptions.

Completed stage-5 state path:

- PG read hydrators return loader evidence but only reconcile normalized Dexie
  rows; they do not call Alpine workspace-data `apply*`/`replace*` methods,
  patch selected records, or assign workspace collections.
- Always-on live queries project personal WApps, scopes, channels, groups,
  workspace members, and daily notes. Section projections cover status, chat,
  files, docs, tasks, and settings; guarded detail projections cover selected
  messages/reactions/activity, tasks/comments, documents/comments, and
  workrooms with participants, events, links, and approvals.
- Projection guards bind both workspace key and owner, so a disposed workspace
  cannot publish a late live-query result. Detail guards additionally bind the
  selected record, preserving selection while later service coverage lands.
- Authoritative reconciliation owns deletion/archive filtering in Dexie;
  unchanged member and WApp authority snapshots skip physical writes. Other
  family reconcilers preserve their established pending-write/tombstone rules.

Final ownership categories:

1. Workspace reads moved to Dexie-only materialisation: sync bundles; scope,
   channel, task, document/file, message, comment, reaction, audio-note,
   daily-note, workroom/participant/event/link/approval, workspace-member,
   group, and WApp reads.
2. Workspace UI state consumed through live queries: the collection and detail
   projections listed above. Alpine retains selection, loading/error flags,
   drafts, modal state, pagination intent, and scroll state.
3. Workspace commands: UI code issues named `TowerSyncService.command` intents.
   Descriptors own lifecycle, command generations, coalescing, disposal, and
   normalized Dexie reconciliation where a command returns an authoritative row.
4. Non-workspace exceptions: edit leases, application-version checks, browser
   signer availability, external Nostr profiles, storage upload/download
   responses, and immutable document-version preview.

Stage-6 command boundary:

- `TowerSyncService.command(name, input, options)` owns mutation-id
  coalescing, acknowledgement reuse, per-record generations, stale
  acknowledgement rejection, failure callbacks, and workspace-disposal guards.
- UI consumers of `pg-write-adapter.js` now issue intents through
  `tower-command-intents.js`; `tower-command-port.js` is the only production
  importer of that low-level adapter.
- Task-comment create is fully descriptor-owned: the command port persists the
  optimistic Dexie row, reconciles the authoritative id/row, and persists a
  failed row on rejection. The task-detail manager keeps only draft/error UI
  state and no longer schedules a success readback.
- Task, document/file/audio, message/thread/comment, reaction, daily-note,
  workroom/approval, WApp, channel/scope, member/access/configuration,
  notification, invocation, and resource-view commands have registered names in
  `TOWER_WORKSPACE_COMMAND_CONTRACT`. Static tests compare every intent consumer
  with that registry, so a new command cannot silently bypass the service.
- Adapter-backed task, document/file/audio, message, and comment descriptors
  persist optimistic rows and authoritative mapped rows in Dexie, reconcile
  temporary IDs where applicable, restore a supplied previous row on failure,
  and inherit service stale-acknowledgement and disposal guards.
- Workroom lifecycle/approval, reactions, personal WApps, WApp publishing and
  activity, daily notes, scope/channel lifecycle, and resource-view-state
  descriptors map returned authority rows into their normalized Dexie tables.
- Encrypted compatibility families issue `compatibility.pending-write`. The
  descriptor is the sole UI-side pending-write enqueue owner. The enqueue result
  is transport acknowledgement only; the existing checkout-aware worker flush
  and SSE bundle materialisers provide authoritative reconciliation, retain
  pending rows/tombstones on failure, and prevent stale resurrection.
- Command success does not start collection/detail polling. Authoritative
  command rows or the existing targeted SSE materialisation provide coverage.
- Channel, scope, grant, workspace membership/group, workspace profile/removal,
  PG bootstrap, and notification configuration managers issue named service
  intents. Scope/channel create, update, and delete descriptors own optimistic,
  authoritative, id-reconciliation, and rollback Dexie writes. Channel ordering
  keeps its existing optimistic ordered Dexie batch while dispatch, coalescing,
  disposal, and acknowledgement ownership sit at the service boundary.
- Channel metadata/create/order and scope create/delete no longer trigger broad
  post-write collection readbacks; command rows and existing SSE materialisation
  are authoritative. Selection remains ephemeral Alpine state.
- Channel-grant and group-membership changes intentionally retain a forced access-materialisation
  pass. The typed grant acknowledgement contains only the grant row, while the
  changed principal can gain or lose visibility across scopes, channels, tasks,
  documents, and audio notes; Tower does not return that affected record set in
  the command response. The pass is bounded to those access-sensitive families.

Acknowledgement plus targeted-coverage commands:

- Task assignment deltas, thread lifecycle/title, channel ordering, workspace
  and notification configuration, WApp ordering, Daily Scope agent access,
  invocation creation, and document/file metadata commands return either a
  zero-write acknowledgement or one targeted authority row. Their managers do
  not start broad collection polling; existing family SSE coverage or the
  targeted returned row supplies materialisation.
- Channel grants and group membership can change visibility across several
  families. Their acknowledgement cannot enumerate the newly visible or hidden
  set, so the existing bounded access-materialisation pass is retained for
  scopes, channels, tasks, documents/files, and audio notes. This is not an
  unbounded workspace refresh.
- Unchanged acknowledgements do not cause a descriptor reconcile write when
  there is no authoritative row, and mutation-id reuse prevents duplicate send.

Retained exceptions:

- `sync-manager.js` still mints SSE auth, handles status, and runs polling;
- `sync-worker-client.js` and `sync-worker-runner.js` still own the worker and
  physical EventSource/outbox timer implementations;
- `pg-read-hydrator.js` remains the service-owned PG read/materialisation port;
  architecture tests freeze its Dexie-only output boundary;
- `wapp-command-support.js` is a compatibility re-export only: command exports
  point to service intents and mapping/context exports point to the read
  hydrator. It performs no transport itself.
- Legacy encrypted group-key administration remains an authority/cryptography
  operation rather than a workspace record-family materialiser. It can refresh
  groups/access after membership changes because the command response cannot
  express rotated keys and transitive visibility.
- Document version history is an immutable, explicitly opened audit preview
  without a Dexie family. Edit leases, application version checks, signer
  availability, external Nostr profiles, storage byte transfer, connection
  discovery/bootstrap, and command acknowledgements are non-workspace or
  transport exceptions.

The dependency tests prevent direct PG write-adapter imports, direct active
typed-command imports from `api.js`, UI-side `addPendingWrite`, unregistered
command intents, response-to-Alpine hydrator writes, and the retired broad
post-write refresh signatures. New managers may not expand the frozen low-level
read/transport exception set.

## Migration sequence

1. Stage 2 moves workspace bootstrap and WApp activity, mutes, publishing
   grants, and personal-WApp reads behind service loaders/materialisers.
2. Stage 3 moves scope, channel, task, and document collection hydration.
3. Stage 4 replaces detail/comment calls with coalesced `ensureLoaded` calls.
4. Stage 5 removed Tower-response-to-Alpine `store.apply*` paths so Dexie live
   queries are the only workspace-data path.
5. Stage 6 routes writes consistently through the boundary, registers every
   active command family, and removes obsolete successful-write refresh paths.

Non-workspace exceptions remain outside this service: edit leases, application
version checks, signer availability, external Nostr profiles, storage transfer,
and command acknowledgements.

## Optional native Tower transport

The connection path is independent of the service workspace key. The shared
Tower request resolver signs the selected physical endpoint while keeping
backend/workspace identity and Dexie keys logical. WMapp supplies paired native
byte transport; the existing worker continues to own SSE parsing, token requests,
reconnect and cursor acknowledgements. `prepareTransportReload` pauses the
existing lifecycle and settles in-flight service work before the same-origin
reload. Pairing identity probes are connection checks, not materialized workspace
reads. See `../fips-transport.md` for the v2 contract and storage behavior.

## Connectivity recovery during fallback polling

A committed workspace sync for the active connection clears a stale Tower
connection warning even when SSE is still probing or using fallback polling.
This also covers startup and SSE catch-up reads outside the background tick.
Failed pulls, offline browsers, and completions from a previous workspace do
not establish recovery.

Activity and session-health recovery run before the fallback workspace pull,
but their errors must not skip that pull. Activity recovery keeps its own visible
error and bounded retry state. The workspace pull establishes whether general
Tower connectivity is usable; a failed pull keeps the connection warning.
SSE lifecycle diagnostics continue to show stream reconnect/fallback details.

## Subscribed feed families

The additive `feed_subscription` and `feed_item_state` PG families materialize
through the existing record-delta worker and actor-guarded SSE path. The
`feed-reader` family owns typed hydration; `feed-subscription.create`,
`feed-subscription.patch` and `feed-state.patch` command descriptors own CAS,
mutation acknowledgement and original-partition offline intent recovery. UI
collections remain Dexie liveQuery projections. Source fetching is a separate
bounded WApp/public service and never adds Tower polling or another SSE owner.
See [reader implementation](wapp-feed-reader-proposed.md) for source-only support
and remaining integration limits.
