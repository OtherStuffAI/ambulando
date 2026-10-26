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
   The snapshot is resumable: generation, `S` and the page cursor are persisted
   after every page, a pass processes a bounded number of pages, and the next
   pass continues from the saved cursor. The inbox is `ready` (and anything is
   deleted) only after `next_cursor=null`; an expired cursor restarts it once
   with a new origin.
2. Steady state: hint -> `changes?after_seq=local_seq`. `local_seq` only
   advances to a delivered `through_seq`.
3. `410 reset_required` -> cold start again; unsent intent is kept. A `reason:
   "rules_changed"` reset additionally marks the settings list stale so it is
   refetched.
4. Hydrated partition is `inbox`. Dismissed items are never hydrated; archived
   items load on demand and then follow `changes`.
5. `counts` is compared with the local derived count when no intent is pending
   and the local cursor has caught up; a disagreement triggers one rebuild per
   five minutes.
6. A missing collection route (older Tower) is stored as `unsupported` and is
   not retried for ten minutes. Existing alerts and Needs You are unaffected.

## Per-app view and rules (wire v1.1)

- `client_app_id=ambulando` is sent on `items`, `counts`, `changes` and in the
  bulk `selector`. It is a presentation filter, never authority: an item hidden
  from this app still exists with one shared `row_version` and read state, and
  other apps keep seeing it.
- `rules_revision` is taken from the first snapshot page, persisted with the
  snapshot, and sent as `changes?rules_revision=R`. A mismatch (`410
  reset_required`, `reason: rules_changed`) or a `counts` response with another
  revision rebuilds the snapshot and refetches preferences. `changes.through_seq`
  may jump to the head after a filtered page; an emptied page advances the
  cursor and does not loop.
- `PUT rules` is per-key compare-and-set. Only this app's own key
  (`client_app_id=ambulando`, never `*`) is written, with the `row_version` of
  that exact key from the last read (`0` only when absent; a durable
  `mode:"default"` row supplies its version while the registry default decides
  the display). `409 rules_conflict` writes nothing: all current rules and the
  revision are adopted and the user retries (new `mutation_id`).
  `mutation_id_reused` is a rejection. Effective display uses the contract's
  precedence `(src,cat) > (src,*) > (*,cat) > (*,*)`, this app's key before `*`
  at the same level. A category turned off for every app (`*`) is shown locked,
  because Tower never creates the item.

## Commands

Read/unread/dismiss/archive intents are queued in Dexie (`notification_inbox`),
overlaid at render time and sent through the sync owner with a fixed
`mutation_id`:

- `expected_row_version` and `observed_change_seq` are captured when the user
  acts, never when the request is sent. A newer fold therefore conflicts.
- Any intent that clears activity (`read:true`, `dismissed:true`, `archived:true`)
  that conflicts with a newer server row is dropped with a notice, so unseen
  activity stays unread. Only un-do intents (mark unread, restore) are
  re-applied once against the server row with a new `mutation_id`; intents the
  server already satisfies are simply completed.
- The version captured is the one the user saw rendered, not one stored by a
  later sync.
- "Mark all read" is a bulk `up_to_seq = local_seq`; concurrent newer items stay
  unread.
- Sent bodies are immutable across uncertain retries. An identical retry returns
  the original acknowledgement (200); `409 mutation_id_reused` means a different
  request used the id, so the intent is rejected with a notice and the state is
  re-pulled.

## Semantics that must not be merged

- Notification read/dismiss/archive never writes resource view state.
- Opening a notification loads and navigates first, then marks only that
  notification read using the rendered version. If loading fails the route still
  opens from saved data but the notification stays unread (the resource-view
  bridge will derive read when the resource is viewed).
- A future item schema/version renders as a generic card and is still tracked by
  id and sequence; it never fails sync.
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
