# Workspace Canvas

Canvas is a workspace feature, not a separate application. The Deck lists the
canvases visible to the signed-in actor and opens one in a new browser tab at
`/canvas.html`. That page has its own Vite entry point and deliberately does not
load the normal scope, channel, Inbox, or Deck shell. Closing the tab therefore
returns the user to the already-open Ambulando tab without rebuilding its state.

Canvas provides an infinite pan-and-zoom surface, persistent native text and
shape elements, threaded comments, workspace/restricted visibility, ordering in
Deck, and read-only document, task-list, chat-thread, and trusted HTML naplets.
Canonical source editing remains in Ambulando's existing editors. A naplet
stores a source reference and layout only; it does not create a second document,
task, or chat store.

## Authority and storage contract

Tower/NStack owns the canonical Postgres rows and all authorization. The browser
uses signed `/api/v4/flightdeck-pg/workspaces/:workspaceId/canvases` routes. The
contract is:

- `GET /canvases` returns a complete, ordered list filtered by canvas visibility.
- `POST /canvases` creates a definition; `PATCH /canvases/:canvasId` updates its
  title, visibility, or viewport and requires `expected_row_version`.
- `PUT /canvases/order` accepts the complete visible `canvas_ids` order.
- `GET /canvases/:canvasId/snapshot` returns one authorized canvas and its
  independently authorized naplets.
- `POST /canvases/:canvasId/naplets` adds a source reference and layout.
- `PATCH /canvases/:canvasId/naplets/:napletId` updates naplet layout using
  `expected_row_version`.
- `DELETE /canvases/:canvasId/naplets/:napletId` tombstones a naplet using
  `expected_row_version`.
- `POST /canvases/:canvasId/elements` creates text, shape, connector, drawing,
  or frame rows; element PATCH/DELETE routes use `expected_row_version`.
- `GET/POST /canvases/:canvasId/comments` reads and creates canvas or naplet
  threads; comment PATCH resolves or reopens a root thread using CAS.

Every response is bound to `workspace_id` and an `identity` object containing
`workspace_id`, `app_npub`, `tower_service_npub`, and
`workspace_service_npub`. List and snapshot reads carry `complete: true`; the
client rejects incomplete, duplicate, foreign-workspace, or foreign-authority
payloads instead of merging them into local state.

The Tower schema has a workspace-scoped canvas definition table, a canvas
visibility principal table (actor or group), naplet and native-element tables,
and a threaded-comment table. Naplets retain
source type, source UUID, layout JSON, immutable HTML package version/digest
where applicable, position, and monotonic row version. Deletes should use the
same tombstone and cursor conventions as other Tower record families. Tower
must validate source type and ownership, use database transactions for complete
reorders, and enforce row-version compare-and-swap on concurrent layout writes.
The client route implementation is not evidence that these authoritative Tower
tables and handlers are deployed; activation must be reported separately.

## Authorization and disclosure boundary

All requests use the established NIP-98 signing path with the workspace and app
authority tuple. Browser users and agents authenticate through the same routes
and receive the same policy result; there is no unsigned agent-only shortcut.
Tower first authorizes the actor for the canvas, then authorizes every naplet's
source through that source family's existing policy. Canvas visibility never
grants document, task, channel, thread, or object-storage access.

An authorized source is returned as `access: "ready"` with only the render
projection for its family. A source the actor cannot read is returned as:

```json
{
  "id": "opaque-naplet-id",
  "access": "denied",
  "layout": { "x": 0, "y": 0, "width": 360, "height": 280, "z": 1 },
  "row_version": 1
}
```

It must not include source type, source ID, title, filename, author, excerpt,
content, timestamps, storage keys, or other metadata. The client drops those
fields even if a faulty server supplies them and renders exactly “Ask your
workspace owner for access.” Canvas 403 and 404 failures intentionally share a
generic unavailable state.

Dexie v41 stores viewer-partitioned `canvas_definitions` and `canvas_snapshots`
as rendering projections. Partitions include backend, Tower/service/app
authority, workspace, viewer, actor, and workspace database key. A narrow
Canvas sync service is the only Canvas network/update owner. It performs signed
hydration and mutations, serializes CAS writes, reconciles from Tower, and
materializes the result into Dexie. Both the Deck manager and the Canvas-only
entry use this boundary; the latter starts no broad shell subscriptions and
renders only its `liveQuery` snapshot. It never renders a saved snapshot until
a fresh signed snapshot succeeds; failed authorization clears that snapshot.
Dexie is not an offline authority or an alternative synchronization owner.
Signed network work completes outside Dexie transactions; projection commits
use Dexie-owned promises only, preventing transactions from auto-committing
while external/native promise work is pending.

## Whiteboard interaction and comments

The dedicated page exposes selection and hand tools; text, rectangle, diamond,
ellipse, arrow, line, free-draw, and frame elements; erasing, duplicate,
forward/back ordering, resize, undo/redo, reset, and fit. Ordinary wheel input
pans. Ctrl/Cmd-wheel and two-touch pinch zoom around the pointer or gesture
centre, while one-touch dragging pans without allowing the page to take over.

The naplet picker lists cached, visible typed sources rather than accepting raw
record IDs. Tower still re-authorizes the chosen source at creation and every
snapshot read. Comments may be anchored to canvas coordinates or a naplet and
support one reply level plus resolve/reopen state. If the viewer loses access
to an anchored naplet, Tower emits a coordinate anchor and never exposes the
protected naplet identifier or metadata through the comment projection.

## Trusted HTML naplets

HTML naplets accept only versioned, immutable packages admitted by Tower's
trusted artefact policy. The current browser boundary is defense in depth, not a
safe renderer for arbitrary untrusted code:

- an iframe with `sandbox="allow-scripts"` creates an opaque origin and grants
  no same-origin, forms, popups, top-navigation, downloads, or presentation;
- `credentialless` and `referrerpolicy="no-referrer"` prevent ambient host
  credentials and referrer disclosure;
- the generated document applies a deny-by-default CSP with no network,
  frames, forms, objects, or base URL, while allowing inline scripts/styles and
  data/blob assets needed by self-contained interactive artefacts;
- a leading guard cancels links and form submissions and disables
  `window.open`; and
- the host exposes no postMessage or application API in this first slice.

Because arbitrary script can still attempt browser navigation and resource
exhaustion, packages that are not trusted, immutable, source-reviewed, and
digest-verified at ingestion must be rejected by Tower rather than relying on
the iframe alone. A future bridge must use explicit message schemas, origin/source
checks, capability tokens, and narrowly scoped operations.

## Verification and activation

Unit coverage exercises strict authority normalization, viewer-partitioned
Dexie projection, non-disclosing denied naplets, HTML document hardening, and
exact signed route/method/payload construction. The synthetic browser test opens
the dedicated production entry, checks that the normal shell is absent, exercises
pan/zoom and naplet creation, renders each source family, verifies the exact
denied state, and demonstrates that self-contained HTML remains interactive
without opening or navigating the host.

Those checks establish the Ambulando client and protocol boundary. They do not
prove that a live Tower has the Canvas schema/routes, that its source-family ACL
queries are correct, or that trusted package ingestion is active. Production
activation requires the owning Tower release plus an authenticated two-actor
integration pass covering allowed, denied, revoked, and concurrent updates.
