# Message activity napplet

Message activity opens from the home Toolbox in a thread-style native modal.
Existing personal WApp launchers remain available. This bundled first-party
napplet is a separate static document in an opaque-origin sandbox with scripts
enabled, no same-origin access, and a CSP that denies network connections,
images, forms, frames and objects. It receives only counts and authorized labels.

## Data and authority

The on-demand `message-activity` TowerSyncService family calls the existing
endpoint-pinned signed Tower transport:

`GET /api/v4/flightdeck-pg/workspaces/:workspaceId/message-activity?range=7d|30d|all`

Tower returns its identity, workspace, range, `from`, identical `to`/`as_of`,
`complete:true`, and authorized `channels:[{channel_id,scope_id,count}]`. The
validator rejects authority mismatches, wrong time windows, partial results,
duplicate channels and unsafe counts. Tower owns canonical distinct-ID counting,
creation-date filtering, deletion and ACL decisions. Replies count in their
actual channel; effective/inherited transcript cache rows are irrelevant.
Authorized zero channels are included. The UTC interval includes `from` and
excludes `as_of`; all time has a null `from`. Scope totals sum channel counts.

Snapshots persist in the workspace Dexie `message_activity` projection table,
partitioned by logical Tower/service, app, workspace, owner, session/viewer and
range. They are local read projections, not synced record families or outbox
writes. LiveQuery joins aggregate IDs with existing authorized channel/scope
labels and publishes only an explicit aggregate view to the frame. Missing
metadata uses neutral labels without losing counts. There is no message crawl,
second sync client, new polling timer, credential transfer or arbitrary request
bridge. Normalization is bounded by the authorized channel list, not history.

Each open/refresh/range read carries a new request ID. Only that request's
persisted row can reach the active frame. Old snapshots remain durable but are
never displayed before current authorization succeeds. Loading and errors clear
all counts. Refresh fetches a new complete snapshot; liveQuery updates metadata
labels, not server counts between snapshots. Counts describe the displayed
server instant, not a live counter. An unavailable endpoint shows a useful error
and never substitutes partial message-cache counts.

## Bridge and lifecycle

The host validates the exact frame window, opaque origin, random session token,
protocol version, message shape and fixed range. Only `ready`, `refresh`, `range`
and `close` are accepted. Extra fields, workspace selection, fetch/sign intents
and foreign senders are rejected. Responses whitelist aggregate fields; labels
render with `textContent`. The static asset cannot access the host DOM/storage.

Scope selection, workspace generation/identity changes, pagehide and close abort
reads, unsubscribe liveQuery, remove bridge listeners and blank the frame. The
service also aborts reads on disposal. Guards reject late completions before and
inside the Dexie transaction. Range changes abort superseded requests. Repeated
refresh during loading cannot amplify reads. Native dialog provides modal focus
containment, background inertness and focus restoration; Escape inside the frame
uses the validated close intent. Desktop and narrow screens share this lifecycle.

Installation/catalog, placement persistence, S3/relays and generic permission UI
remain follow-up work. Production data correctness and real authenticated
aggregate transport require manager activation/live smoke; fixtures and synthetic
browser tests do not establish live acceptance.

## Window controls

The host reuses thread header controls and the full-page panel dimensions.
Expand/collapse changes only the open dialog's CSS class: its frame, session,
current snapshot, range, navigation history and pending read remain intact.
Native focus containment and restoration apply in both presentations.

Back/forward traverse the host's time-range history (7 days, 30 days, all time),
never the browser's history. A new range after going back discards the forward
branch; repeated selection does not add an entry. History resets on close or
context invalidation. Traversal performs a newly authorized read through the
existing service rather than displaying a cached snapshot before authorization.
The ellipsis menu offers refresh, expand/collapse and close. Escape dismisses
an open menu first, then closes the napplet; outside clicks and focus leaving the
menu dismiss it. Presentation transitions never initiate an aggregate read.
