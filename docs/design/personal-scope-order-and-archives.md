# Personal scope order and incremental archives

Scope Management stores navigation order per actual reader and workspace. It does
not update shared scope positions. `GET/PUT /me/scope-order` uses reader NIP-98
authentication (never the workspace owner key), an expected row version and a
mutation UUID. Tower serializes each reader's writes, returns conflicts for stale
revisions, and replays an identical mutation without another write. Existing
personal agent/feed preferences describe different resources; navigation order
uses the same actor-bound pattern with its own canonical family.

The `scope_order` journal family and outbox wake event are private to that actor.
Managed event audiences cannot delegate these preferences. TowerSyncService owns
recovery and hydration; Dexie `scope_orders` and liveQuery provide the rendered
order. Before the service is initialized, the sync-manager fallback dispatch uses
the same canonical scope-order hydrator; requesting the preference alone does not
initialize the service or bootstrap the workspace. Unknown scopes append in their
existing order. Drag placement and Move Up/Down issue the same preference command.
Each save first reads the current actor-bound preference revision. The rendered
liveQuery value can be absent during reader initialization or lag a completed
write, so it must not supply `expected_row_version`. The save stays busy during
that read and command acknowledgement; each explicit move has a new mutation UUID.
A concurrent-write conflict refreshes the preference and asks for another explicit
move rather than automatically overwriting the other session's change. Failed
saves clear old success notices. Reads and acknowledgement materialization capture
the reader, workspace, selection generation, backend, app and Dexie handle; late
responses cannot write into a newly selected partition. These checks supplement
Tower's revision and permission checks; they do not delegate reader authority or
replace the canonical sync device lease.

Only active normal roots participate in reordering; system, DM and virtual roots retain navigation but have no reorder
controls and never enter the preference payload. Move boundaries use eligible
roots rather than the full navigation tree.

Scope/channel archives retain tasks, documents, messages, files and grants.
Archiving a scope archives its channels in one transaction. Existing capture
triggers emit scope/channel tombstones; route audit and wake events commit with
them. Authorized DELETE retries return the archived row without duplicate audit.
DM scopes, system channels and channels with a system_key remain protected.
DM conversations support the same global archive with channel.manage permission;
this removes access for all participants, not an actor-only hide. DM rename and
sharing controls remain separate. Management permissions are
checked again inside the serialized archive transaction.

An archive alone does not rotate the record epoch. Current actor/group grants
permit identifier-only tombstones after archival, including scope tombstones
for child-channel readers. Never-entitled actors receive neither tombstones nor
archived content. Grant/membership/owner/group changes and restores retain their
existing authority epoch resets. Preference changes do not invalidate authority.

Dexie records accepted scope/channel tombstones in `pg_archived_targets` without
rewriting child content or deleting pending writes. Live projections suppress
archived content, even if an older hydration arrives. TowerSyncService rejects
new loads for archived destinations. Dirty editors persist local recovery drafts
before navigation falls back to the all-scopes overview. Accepted active upserts
clear archive markers; stale tombstones cannot override newer active versions.

SSE archive/preference hints use canonical cursor recovery without scope/channel
list hydration. Existing connected and offline cursor paths reconcile the same
small journal entries. An actual permission change still uses the normal ACL
recovery path. The service registration historically calls this journal catch-up
`workspace-bootstrap`; with a valid cursor it issues record-sync deltas and does
not request a bootstrap snapshot.

Coverage includes signed isolated Tower routes, two concurrent SSE streams,
private preferences/conflicts/replay, child-only visibility, hidden readers,
channel-only rollback, v1 and v2 reconnects and retained checkpoints. A loopback
browser request harness exercises three real TowerSyncService instances,
IndexedDB and liveQuery, preference reload, archive fallback and unchanged
pending edits/caches/cursors with exact cursor-only request assertions. The
browser harness and signed Tower tests are separate; it is not a live end-to-end
browser authentication test.

Scope Management also supports shared channel ordering within each expanded
scope. Drag a manageable channel onto a sibling, or use its Move Up / Move Down
buttons. Both use the existing 1-based channel reorder command and authoritative
Tower channel positions, independent of personal scope order. Unselected channels
use their own embedded grants for management checks. Channel drag events stop at
the channel row so they cannot reorder the containing scope. Saving disables
further channel moves; a rejected save restores the previous positions and shows
an explicit retry message. Reorder acknowledgements preserve embedded grants
when Tower returns a sparse channel projection.

The reader/workspace-validated preference also drives expanded sidebar scope
navigation, Deck and task scope selectors, scope search and creation defaults.
Each projection retains its existing fallback order for scopes absent from the
preference; All and DM shortcuts retain their dedicated placement. Scope levels
and parent links remain authoritative: personal order changes sibling placement,
not shared hierarchy. In PG workspaces, scopes are top-level work areas, so a
scope immediately below another in the saved order is still a sibling. Live
preference materialization updates these projections without rewriting scopes or
channel positions; Dexie retains the preference across reload.
