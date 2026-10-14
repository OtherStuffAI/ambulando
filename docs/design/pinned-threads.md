# Personal pinned threads

Pinned threads keep conversations visible after reading them. The desktop Deck
sidebar shows a compact list above Feeds; the mobile Deck pager has its own
Pinned threads page while pins exist. The empty panel and mobile page are hidden.
On desktop the panel fits its rows, showing up to ten before scrolling. Inbox chat rows have a native pin button with a pressed
state. Each pinned row shows its current title and relative activity time with
the existing unread background, plus an unpin button. Opening uses the existing
Deck thread modal and channel resolver, including destinations in another scope.

Pins are independent of scope, channel, Inbox search, type filters and paging.
Newest pins come first, with thread ID as a deterministic tie breaker. Activity,
read receipts and title changes update the row without moving it. Unpinning and
pinning again places the thread first. Pin operations do not modify thread
records, read positions, Inbox order or shared record outboxes.

Selections now synchronize through Tower's typed personal `thread_pin` family.
The authenticated canonical actor and workspace own each per-thread row; the
browser additionally partitions backend/app/workspace/reader state. Pins and
retained unpin tombstones recover via the existing record snapshots/deltas and
actor-private SSE hints. TowerSyncService remains the only network/update owner.
No UI polling or second synchronization lifecycle is added. The record family
list negotiates support; older Tower connections retain legacy pins locally and
show a device-only notice. Migration waits for support, so missing routes cannot
discard old pins.

Dexie `thread_pins` stores canonical rows and `thread_pin_outbox` stores immutable
per-thread operations. Pending changes appear immediately through liveQuery.
The existing materialization worker prepares migration and reconciles command
acknowledgements; ordinary record pages materialize the new family there too.
Transport responses, local canonical rows and rendered pin cards stay distinct.

Legacy app_settings partitions remain intact. An atomic local migration marker
and import queue preserve each device's old selections. Tower imports only absent
actor/thread pairs; existing pins and permanent unpin tombstones take precedence.
Repeated migration and a stale device cannot resurrect an intentional unpin.
Imports of missing/inaccessible threads retain UUIDs only and display unavailable.
Clearing browser data loses unsent work; acknowledged pins remain on Tower.

CAS applies independently per thread. Two independent pins merge. Same-thread
races have one accepted revision and one conflict. Offline retries keep the exact
mutation ID and base revision, replaying the original acknowledgement after a lost
response. A conflict discards that request and its dependent local toggles,
recovers canonical state and shows an actionable notice; it never silently rebases
stale intent. Users can explicitly pin again after recovery. Temporary failures
retain pending work for the existing sync/reload retry path. Unavailable pins
remain removable. Read receipts and Inbox ordering are unaffected.

See Tower's `docs/contract/personal-thread-pins-v1.md` for the typed request,
authorization, permanent tombstone and idempotency contract.

A workspace-bound liveQuery reads the selected identifiers, canonical thread and
source rows, channel, latest indexed reply and persisted attention. This is
bounded by the number of pins rather than the workspace history size. Workspace
and authentication changes hide the old projection immediately and replace its
subscription. Logout/workspace query disposal stops the subscription. Missing,
deleted, archived and inaccessible records show “Thread unavailable,” disable
opening and retain an unpin action; cached titles are not displayed in that state.
A later local hydration can restore a missing row. Pinning does not initiate a
second network synchronization owner.

Verification: tests/pinned-threads.test.js exercises real Dexie legacy preferences,
liveQuery updates, reader/workspace boundaries, indexed replies, unavailable
records, navigation dispatch and unchanged thread/read/outbox records.
tests/e2e/pinned-threads.spec.cjs renders production templates/styles and exercises
production pin code using isolated browser IndexedDB and seeded records. Those
checks establish local behavior, not authenticated Tower delivery or physical
phone/browser behavior. The normal performance baseline remains required.
