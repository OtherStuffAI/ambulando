# Personal pinned items

Personal pins keep conversations, tasks and documents visible after reading them. The desktop Deck
sidebar shows a compact list above Feeds; the mobile Deck pager has its own
Pinned items page while pins exist. The empty panel and mobile page are hidden.
On desktop the panel fits its rows, showing up to ten before scrolling. Inbox chat rows have a native pin button with a pressed
state. Each pinned row shows its current title and relative activity time with
the existing unread background, plus an unpin button. Opening uses the existing
Deck thread modal and channel resolver, including destinations in another scope.

Pins are independent of scope, channel, Inbox search, type filters and paging.
Newest pins come first, with thread ID as a deterministic tie breaker. Activity,
read receipts and title changes update the row without moving it. Unpinning and
pinning again places the thread first. Pin operations do not modify thread
records, read positions, Inbox order or shared record outboxes.

Selections now synchronize through Tower's typed personal `personal_pin` family.
The authenticated canonical actor and workspace own each per-thread row; the
browser additionally partitions backend/app/workspace/reader state. Pins and
retained unpin tombstones recover via the existing record snapshots/deltas and
actor-private SSE hints. TowerSyncService remains the only network/update owner.
No UI polling or second synchronization lifecycle is added. The record family
list negotiates support; older Tower connections retain legacy pins locally and
show a device-only notice. Migration waits for support, so missing routes cannot
discard old pins.

Dexie `thread_pins` stores canonical rows and `thread_pin_outbox` stores immutable
per-type, per-resource operations. Pending changes appear immediately through liveQuery.
The existing materialization worker prepares migration and reconciles command
acknowledgements; ordinary record pages materialize the new family there too.
Transport responses, local canonical rows and rendered pin cards stay distinct.

Legacy app_settings partitions remain intact. An atomic local migration marker
and import queue preserve each device's old selections. Tower imports only absent
actor/thread pairs; existing pins and permanent unpin tombstones take precedence.
Repeated migration and a stale device cannot resurrect an intentional unpin.
Imports of missing/inaccessible threads retain UUIDs only and display unavailable.
Clearing browser data loses unsent work; acknowledged pins remain on Tower.

CAS applies independently per resource type and ID. Two independent pins merge. Same-thread
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


Tasks and documents use the same list and synchronization owner. Their Inbox
cards and persisted detail headers have the same faint pin control; the selected
state fills the pin without a box. Cards carry type icons and typed accessible
names. Type/ID keys prevent collisions when different resource tables contain the
same UUID. Pin actions store IDs only, never draft titles, bodies or assignments.
Task/document rows use canonical Dexie titles and personalized attention. Normal
internal-reference navigation handles opening, scope changes, drafts and reads;
pinning itself does not open, mark read, acquire a lease or change edit mode.

The v40 Dexie upgrade adds typed indexes and upgrades the thread checkpoint's
rows/outbox atomically, retaining mutation IDs, base versions and tombstones.
Tower's idempotent migration retains row UUIDs, versions, receipts and cursor
epochs while current rows move to the personal_pin family. Legacy journal rows
remain immutable and readable. New task/document pins are explicit local
operations, retained on this device if the connected Tower lacks the contract.

Verification includes the real HTTP/Postgres two-client test in
`tests/thread-pin-sync.integration.test.js`, v39 cache migration in
`tests/personal-pin-upgrade.test.js`, typed projections in
`tests/thread-pin-store.test.js`, and task/document browser controls and existing
open paths in `tests/e2e/personal-pins.spec.cjs`. Cross-device runtime activation
must be reported separately from these disposable production-route tests.

Channel pins use resource_type `channel` in the same personal_pin family and outbox. The channel Inbox heading includes its current name and an accessible pin toggle. Pinned channels open through selectDeckChannel, independent of the selected scope. Their blue state follows isChannelUnread and clears through the existing read flows; pinning and opening the Deck do not themselves write read receipts. Missing, archived or inaccessible channels retain a removable unavailable pin without exposing their cached title.

Personal order uses Tower's `POST /me/pin-order` move contract. Channel pins have
an explicit hashtag; conversation pins keep their chat icon. All four pin types
share drag handles, a destination line and edge scrolling. Focus a handle and
press Space/Enter to pick up, Arrow Up/Down or Home/End to choose a position,
Enter/Space to save, or Escape to cancel. Touch dragging is confined to the
44px handle so the rest of the list retains native scrolling and opening.
Moving never opens/unpins an item or changes a read receipt. Unavailable items
remain movable and removable without exposing cached titles.

Null/missing `order_position` rows sort first by descending pin timestamp and
typed ASCII key, preserving legacy ordering and placing new/repinned items first.
Positioned rows follow by position. Moving submits one typed target and optional
before-anchor, each with its canonical revision. Tower normalizes active rows;
concurrent additions stay selected and stale target/anchor moves conflict.
An immutable order operation lives in `thread_pin_outbox` with its original
mutation ID and revisions, projects immediately through liveQuery and retries
through the existing TowerSyncService pin family. Another move waits while any
pin operation is pending, avoiding guessed normalization revisions. Pin/unpin
remains available. A terminal conflict removes the move, requests normal cursor
recovery and asks the user to try again; there is no silent rebase. Old order
acknowledgements cannot overwrite newer rows or unpin tombstones. Clearing local
browser data can lose unacknowledged moves, as with other pending pin changes.

Support is learned from `personal_pin_order_version: 1` on record-sync pages. Older Tower servers
retain existing pins and show an explanation on a move attempt until upgraded.
Real signed HTTP/Postgres two-client ordering coverage is in
`tests/thread-pin-sync.integration.test.js`; production-panel pointer, Chromium
touch and keyboard checks are in `tests/e2e/personal-pins.spec.cjs`. These do not
establish physical phone behavior or live Tower activation.
