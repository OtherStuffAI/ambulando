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

Selections live in the existing shared Dexie app_settings preference row. Atomic
transactions patch only the selected partition and preserve unrelated settings
and other tabs' pins. The partition includes backend, app, workspace, signed-in
session and actual reader. Pins survive browser reloads, but do not synchronize
between devices: Tower's existing personal preferences describe other specific
resources and do not support thread pins. No new Tower contract is introduced.
Clearing browser data removes these local selections.

A workspace-bound liveQuery reads the selected identifiers, canonical thread and
source rows, channel, latest indexed reply and persisted attention. This is
bounded by the number of pins rather than the workspace history size. Workspace
and authentication changes hide the old projection immediately and replace its
subscription. Logout/workspace query disposal stops the subscription. Missing,
deleted, archived and inaccessible records show “Thread unavailable,” disable
opening and retain an unpin action; cached titles are not displayed in that state.
A later local hydration can restore a missing row. Pinning does not initiate a
second network synchronization owner.

Verification: tests/pinned-threads.test.js exercises real Dexie preferences,
liveQuery updates, reader/workspace boundaries, indexed replies, unavailable
records, navigation dispatch and unchanged thread/read/outbox records.
tests/e2e/pinned-threads.spec.cjs renders production templates/styles and exercises
production pin code using isolated browser IndexedDB and seeded records. Those
checks establish local behavior, not authenticated Tower delivery or physical
phone/browser behavior. The normal performance baseline remains required.
