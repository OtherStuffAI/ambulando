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
order. Unknown scopes append in their existing order. Drag placement and Move
Up/Down issue the same preference command.

Scope/channel archives retain tasks, documents, messages, files and grants.
Archiving a scope archives its channels in one transaction. Existing capture
triggers emit scope/channel tombstones; route audit and wake events commit with
them. Authorized DELETE retries return the archived row without duplicate audit.
DM scopes and DM/system channels are protected. Management permissions are
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
