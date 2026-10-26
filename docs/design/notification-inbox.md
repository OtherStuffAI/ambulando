# Notification inbox (browser consumer)

Ambulando consumes Tower's shared, actor-private notification inbox
(`org.wingman.nstack.notifications` v1, items `org.wingman.notification.item`
v1). The authoritative wire contract is Tower's `docs/contract/notifications-v1.md`;
this note records how the browser uses it.

## Ownership

- Tower owns persistence, ACLs, grouping, counts and the per-recipient
  `change_seq`. The browser never derives notifications from records.
- `TowerSyncService` remains the only network owner. Family
  `notification-inbox` (`src/notification-inbox-sync.js`) runs under it; there is
  no second loop. Triggers: the `notification_item` stream hint, workspace
  recovery, the fallback tick while SSE is not connected, panel open, and local
  intent. Overlapping requests collapse to one extra pass.
- Wire parsing is isolated in `src/notification-inbox-wire.js`. Local rows
  (`notification_items`) and rendered rows are flat and separate from transport
  shapes. All rows are keyed by `(backend, app_npub, workspace, actor)`.

## Sync

1. Cold start: page `items?view=inbox`, keeping `head_seq` of the first page as
   `S`; then replay `changes?after_seq=S` until `has_more=false`. Rows not
   re-listed and not newer than `S` are deleted (snapshot generation stamp).
2. Steady state: hint -> `changes?after_seq=local_seq`. `local_seq` only
   advances to a delivered `through_seq`.
3. `410 reset_required` -> cold start again; unsent intent is kept.
4. Hydrated partition is `inbox`. Dismissed items are never hydrated; archived
   items load on demand and then follow `changes`.
5. `counts` is compared with the local derived count when no intent is pending
   and the local cursor has caught up; a disagreement triggers one rebuild per
   five minutes.
6. A missing collection route (older Tower) is stored as `unsupported` and is
   not retried for ten minutes. Existing alerts and Needs You are unaffected.

## Commands

Read/unread/dismiss/archive intents are queued in Dexie (`notification_inbox`),
overlaid at render time and sent through the sync owner with a fixed
`mutation_id`:

- `expected_row_version` and `observed_change_seq` are captured when the user
  acts, never when the request is sent. A newer fold therefore conflicts.
- A conflicting `read` is dropped (newer activity stays unread, with a notice);
  idempotent intents (dismiss, archive, unread) are re-applied once against the
  server row with a new `mutation_id`; satisfied intents are simply completed.
- "Mark all read" is a bulk `up_to_seq = local_seq`; concurrent newer items stay
  unread.
- Sent bodies are immutable across uncertain retries; `mutation_id_reused`
  completes the intent.

## Semantics that must not be merged

- Notification read/dismiss/archive never writes resource view state.
- Opening a notification navigates (the normal open flow writes resource view)
  and marks only the notification read.
- Needs You / attention and Web Push subscriptions are unchanged.
- No historical import: the inbox starts empty at `inbox_started_at`.

## UI

Header bell + panel (`index.html`, `src/notification-inbox-manager.js`): unread
badge, All / Unread / Archived, category filter, mark all read, per-item
read/unread/archive/restore/dismiss, targets routed by typed kind
(`thread`/`channel`/`task`/`doc`/`workroom`; unknown kinds stay as cards).
Settings -> Notifications has inbox on/off per category from
`categories`/`rules` (mandatory categories locked). Quiet hours, installations
and OS push transports are not offered because Tower does not provide them yet.
