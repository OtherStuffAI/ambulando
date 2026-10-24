# Workspace Canvas

Canvas is a workspace feature, not a separate application. The Deck lists the
canvases visible to the signed-in actor and opens one in a new browser tab at
`/canvas.html`. That page has its own Vite entry point and deliberately does not
load the normal scope, channel, Inbox, or Deck shell. Closing the tab therefore
returns the user to the already-open Ambulando tab without rebuilding its state.

Canvas provides an infinite pan-and-zoom surface, persistent native text and
shape elements, workspace/restricted visibility, ordering in
Deck, document, task-list, interactive chat-thread, and trusted HTML naplets.
Canonical source editing remains in Ambulando's existing editors. A naplet
stores a source reference and layout only; it does not create a second document,
task, or chat store.

The first-class **Chat** tool places a new conversation naplet with two-tap
scope/channel selection and the normal chat composer. See [Canvas Chat](canvas-chat.md)
for its draft, binding, signing and reactive lifecycle.

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

Every response is bound to `workspace_id` and an `identity` object containing
`workspace_id`, `app_npub`, `tower_service_npub`, and
`workspace_service_npub`. List and snapshot reads carry `complete: true`; the
client rejects incomplete, duplicate, foreign-workspace, or foreign-authority
payloads instead of merging them into local state.

The Tower schema has a workspace-scoped canvas definition table, a canvas
visibility principal table (actor or group), and naplet and native-element tables. Naplets retain
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

## Whiteboard interaction

The dedicated page exposes selection and hand tools; Words (text), Arrows, Frames and Groups creation; duplicate,
forward/back ordering, resize, undo/redo, reset, and fit. Ordinary wheel input
pans. Ctrl/Cmd-wheel and two-touch pinch zoom around the pointer or gesture
centre, while one-touch dragging pans without allowing the page to take over.

The naplet picker lists visible typed sources rather than accepting raw record
IDs. Documents, task lists and threads come from the local cache; existing HTML
artefacts and boards use the scope-first picker below. Tower still re-authorizes the chosen source at creation and every
snapshot read. Discussion uses chat-thread naplets or document comments.

## Trusted HTML naplets

An HTML naplet names an ordinary Flight Deck File in a channel. With
`source.version_id = null` it follows the File's current version; with a version
id it is pinned to that immutable version. Naplets created before this contract
stored a version id in `source.id`; Tower resolves those to their File and treats
them as pinned. Tower checks channel `file.read` on the File before reading any
version metadata or bytes, rejects versions of another File or workspace and
verifies the stored sha256 before serving HTML. Publishing uses the normal File
version route, so racing publishers are resolved by `base_version_id`.

Viewers can browse versions locally (Older/Newer, a version list and "Back")
through `GET /canvases/:id/naplets/:id/html?version_id=`, a command read that
never changes the shared naplet or the Dexie projection. Canvas managers can
"Pin this version" or "Follow latest" (`PATCH ... { source_version_id }` with
the naplet `row_version`).

These controls are not a strip above the artefact. The naplet title bar shows
the version state (`Latest · v2`, `Pinned · v1 (latest v2)`, `Viewing v1`, with
unavailable-image counts in its tooltip). The cog menu has **Versions…**, which
opens a modal versions dialog with the stepping buttons, the version list and the
pin/follow actions, plus a direct **Back to vN** item while browsing. The dialog
is an ordinary dialog of buttons, so menu semantics stay valid; arrow keys in the
menu skip disabled items, and closing the dialog returns focus to the cog.

### Private images

The HTML may embed `<script type="application/json" id="wingman-artifact-assets">`
listing `{ name, file_id, version_id, sha256 }`. On every read Tower re-resolves
each entry for the viewer: the image File must be readable through its own
channel's `file.read`, the version must belong to it, the object must be in the
workspace owner's storage partition, the digest must match and the type, per
image (8 MiB), count (64) and total (32 MiB) limits must hold. Anything else is
reported as `unavailable` without further detail. These checks use the
platform's normal authority, so workspace owners and others with File authority
keep it; an artefact cannot deny them access, and there is no per-artefact ACL.

The host fetches permitted bytes through
`GET /files/:fileId/versions/:versionId/object` (same `file.read` check,
`private, no-store`, sha256 ETag, `default-src 'none'; sandbox` CSP), verifies
size and sha256 against the authorized manifest and keeps them only in an
in-memory, viewer-scoped cache. They are never written to Dexie or embedded in
snapshots as base64. The frame receives `Blob`s through one postMessage and
creates its own `blob:` URLs, so no credential, signed URL or Tower URL ever
enters the frame.

Authority changes are applied conservatively:

- the iframe document identity includes every asset's authorization, so losing
  (or gaining) access to one image replaces the document and discards blob URLs
  the frame already created;
- a browsed historical version keeps only images the fresh snapshot also vouches
  for and is re-read under the new authority; if that fails the view closes;
- browse reads apply only if they are the newest for the naplet, the naplet
  policy is unchanged and no fresh snapshot arrived while they were in flight
  (otherwise they are repeated); and
- the byte cache refuses loads outside the latest authorized set and discards
  in-flight fetches for images dropped meanwhile, so revoked bytes cannot
  reappear.

### Choosing an existing artefact

HTML artefacts and "Link existing board" use a scope-first picker
(`src/canvas/artifact-picker.js`). The viewer picks a scope from
`GET /scopes`, then "All channels" or one channel from
`GET /scopes/:scopeId/channels`; there is no workspace-wide channel list.
Files come from `GET /channels/:channelId/files` for the chosen channel, or
for every channel in the scope with at most four channel reads at a time.
All three routes are visibility- or permission-checked by Tower, and nothing
is written to Dexie. The channel file list omits content types, so HTML
artefacts are recognised by `metadata.html_artifact` or an `.html`/`.htm` name,
and boards by `metadata.kind = excalidraw_board`, the board content type or the
`.excalidraw` extension. A channel whose Files are denied is counted as
unavailable instead of failing the list. Changing scope or channel clears the
selection and preview, and stale responses are dropped.

Only the selected HTML File is previewed. Its current version metadata is read
from `GET /files/:fileId/versions`, the bytes from the signed File-version
object route, and the SHA-256 must match before the HTML is used. The manifest
is parsed with the same rules as Tower. Each image is accepted only if its
version is readable to the viewer, matches the manifest digest, has an allowed
image type and fits the size limits; otherwise it is `unavailable`. The preview
renders through the `x-canvas-html-preview` registration of the same sandbox
directive. It uses its own memory-only `CanvasHtmlAssetStore`, which is cleared
when the selection changes, the dialog closes or the page is hidden. Adding
creates the normal follow-latest HTML naplet, and Tower re-authorizes it as
usual.

Tower clamps these list routes to 200 rows and returns no cursor. The picker
requests the maximum and says so when a page comes back full: at most 200
scopes or channels in a scope are listed, and a full channel shows only its
200 most recently updated Files. The merged list is rendered 200 rows at a
time with "Show more", never cut off silently. Version metadata is the newest
200 versions. A manifest image that names an older version of a File with a
full version page is described from its exact version object instead: the same
`file.read` check applies, and its type, size and digest are verified before it
is marked ready. This means the image bytes are fetched twice in that rare case.
No route lists older Files beyond these limits, so the picker does not claim to
show a channel's full history.

### Sandbox boundary

HTML artefacts are **trusted-author executable JavaScript**. The browser
boundary limits what that script can reach; it is not a safe renderer for
hostile code:

- `sandbox="allow-scripts"` only: opaque origin, no same-origin, forms, popups,
  top navigation, downloads or modals. `credentialless` and
  `referrerpolicy="no-referrer"` keep ambient host credentials and referrers out;
- a deny-by-default CSP (`connect-src 'none'`, images/media only from
  `data:`/`blob:`, no frames, objects, forms or `<base>`) blocks `fetch`, XHR,
  WebSocket and remote subresources;
- a leading guard cancels links and form submissions, scrolls in-page `#`
  links locally and disables `window.open`; meta refresh, `<base>` and inline
  event handlers on `<html>`/`<body>` are stripped; and
- the asset bridge accepts exactly one batch, only from the parent window at the
  host origin carrying this document's random nonce. Other naplets, and the
  artefact itself, cannot forge or redirect deliveries.

What it does **not** guarantee: script can still navigate its own frame (for
example `location.replace(...)`), and a navigation request can carry data in its
URL before CSP no longer applies to the new document. The host detects the
document's unload notice, replaces the frame with an inert notice and delivers
nothing further, but this is detection, not network confinement. Script can
also exhaust CPU or memory inside its frame. Only publish artefacts whose
authors you trust with the data they display; do not treat the sandbox as a
review substitute.

The agent publishing helper and its packaging rules are documented in
[`docs/html-artifact-publishing.md`](../html-artifact-publishing.md).

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

## Document naplet reading

Authorized document projections render Markdown through the existing Docs
Tiptap adapter and converter with `editable: false`, sharing document typography.
Each naplet owns and disposes its reader; source-body updates retain the reader,
selection and scroll, while layout-only updates leave content untouched. No
checkout, save or editable draft is created by the canvas reader.

The paper stays white with local ink colors in either shell theme, surrounded
by the shell background. Reading scroll stays inside the naplet; text selection,
touch reading and keyboard input in the document do not invoke canvas gestures
or shortcuts. Header dragging, the resize handle and the explicit hand tool
retain canvas control. The visible “Open in Ambulando to edit” link opens
`/docs` with the current workspace key and exact source document ID in a new tab.
The existing Docs Edit action retains its normal permission and checkout gates.

The Canvas browser fixture checks Markdown headings, lists, links, quotes, code
and tables, read-only input, source refresh without remount, white paper in both
themes at desktop and narrow widths, bounded wheel scrolling and exact link
parameters. This is synthetic client evidence, not authenticated Tower editing.

Add naplet and expanded naplet windows retain native modal semantics. The Deck's
Create canvas/Canvas settings dialog retains its opaque popover surface and
principal picker.

## Naplet window controls

Each naplet has a pale rounded title bar with yellow minimise, green full-screen
and neutral options controls. Minimise hides the content while retaining its DOM;
restore recovers its size and reading position. Full-screen uses `showModal()` on
the same dialog element, avoiding iframe reloads or duplicate document readers.
Native modal focus containment and Escape restore the window; the opener regains
focus. These presentation states are local to the open page, leaving stored
layout and viewport unchanged.

The options popover shares existing source-opening, duplicate, ordering
and removal actions. It enters the native top layer after the modal so controls
remain usable above full-screen content, with arrow/Home/End navigation, Escape,
light dismiss, bounded mobile positioning and larger touch targets. Restricted
items retain the generic title and access message. Management actions follow the
existing canvas capability; Tower remains authoritative for mutations.

Naplet windows also enter the native modal top layer when expanded. Their root
panel uses the same opaque card pair, independently of document paper or HTML
package content. The opacity suite covers expanded document, task-list,
chat-thread, HTML and restricted windows plus their opaque options popover.

Window options explicitly use `max-content` height and grid rows with start
alignment, so top-layer/grid sizing cannot distribute spare height between
commands. The viewport height remains a scrolling cap; rows retain their normal
36px minimum or 44px touch/narrow minimum. The focused
`canvas-window-menu.spec.cjs` checks row height/gaps, content sizing, opaque colors,
keyboard focus, short-viewport scrolling and read-only restricted menus across
normal/expanded windows, all five naplet variants, three widths and four theme
modes. These are synthetic client checks; native Safari and physical touch
behavior need separate device verification.

## Native arrow and text controls

Arrow and line tools preview the stroke directly between the pointer's start and
end. Selecting the stroke shows endpoint handles and one middle handle on the
curve; the generic rectangle outline and resize handle do not apply to lines.
Dragging the middle handle bends the quadratic curve through that point. Endpoint
edits hold the opposite endpoint and existing control point in world coordinates.
The selected line's toolbar offers solid, dotted and dashed strokes, independent
start/end heads (none, open arrow, triangle, diamond, circle), and Straighten.
Selected text exposes a 12–144px font-size field used by both its reader and editor.

These options remain in the existing native element JSON: `start`/`end` and
optional quadratic `curve` are layout-relative coordinate pairs; `lineStyle`,
`startArrowhead`, `endArrowhead` and `fontSize` are optional data fields. No backend
or schema migration is required. Legacy arrows without endpoints retain the
bottom-left to top-right fallback, arrows default to a triangle end head, lines
to no head, and text without a size stays at 16px. Unknown data fields survive
edits. Moving a stroke moves its layout; bending/endpoints save layout and data
together, including undo/redo. Native creation retains its existing history scope.

`tests/canvas.test.js` checks geometry including legacy, reversed, horizontal and
vertical arrows. The native controls scenarios in `tests/e2e/canvas.spec.cjs` use
a dedicated signed synthetic Tower fixture and can exercise the registered app's
actual served assets with `SOL_RUNTIME_ASSETS=1`. They cover mouse and emulated
touch handle/stroke movement, live creation preview, styles, text sizing/editing,
undo/redo, persisted reload and zoom/pan. Physical touch/Safari and authenticated
live workspace writes remain separate integration checks.

## Canvas Link naplets

`source: { type: "canvas", id: <canvas UUID> }` names another existing canvas in
this workspace. Tower rechecks the destination's normal canvas visibility at
creation and every source snapshot, returning only `content: { title }`. The
optional naplet `title` is a display label; the destination title stays visible
in the card. Denied/deleted targets use the existing four-field denied projection.
Self-links are rejected; cycles are allowed and never traversed. Matching Tower
source enum, SQL constraint migration, and resolver support must be active before
creating links. No shared generic record-family schema change is involved.

The add picker performs a fresh signed canvas-list read through the Canvas sync
boundary and Dexie materialization; failed reads offer no cached destinations.
Open canvas is an ordinary same-tab `/canvas.html?workspacekey=…&canvasid=…` link.
Browser Back/Forward owns navigation history. A manually added Canvas Link can
point to an Overview for a permanent return route; there is no hierarchy, custom
Back control, navigation stack, or additional viewport restoration. Returning
from browser back/forward cache requires fresh authorization before rendering.

The Canvas Link picker also offers **Create new canvas**. It opens the shared
Deck name/access dialog above the still-mounted link picker. Creation uses the
same workspace-wide canvas API and visibility principals; canvas definitions do
not belong to a scope or channel. Successful creation refreshes the authorized
list and selects the returned id, preserving the search, optional label and
insertion point. The selected title is announced even when the retained search
filters that row out. Add remains a separate confirmation. Cancel/Escape return
focus to the creation action without modifying the pending link.

The creation response is recorded before list hydration. An accepted create
whose refresh fails retries only the list. A network or server failure with no
confirmed response is uncertain: a sessionStorage marker scoped to the authority,
viewer, workspace and source canvas survives reload. **Check canvas list** reads
fresh choices for explicit selection; it never guesses ownership from a title or
resends the POST. A definitive client rejection leaves the form editable for
retry. Cancellation keeps an uncertain marker; selecting an existing canvas
explicitly resolves it. This protects against blind retries within the current
tab, not independently initiated creations in other tabs or devices. Tower
remains authoritative for creation, visibility and the eventual link mutation.

Cards contain no destination DOM, scene bytes, iframe, preview subscription,
or screenshot. Static thumbnails are deferred because there is no existing
canvas capture/storage contract that safely handles destination revocation.
Title-only cards work without a thumbnail. Pointer actions on the card are
isolated from header dragging and the resize handle. Tests cover signed synthetic
picker/persistence/navigation/denial at desktop and phone widths; physical phone
and authenticated deployed Tower behavior need their own activation check.

## Naplet references

Every readable naplet's cog menu has **Copy reference**. It copies a Markdown
link `[<naplet title> · <canvas title>](<origin>/canvas.html?workspaceid=…&canvasid=…&napletid=…)`.
The URL names Tower ids only: no local workspace key, session, token or source
identity, so it works in another browser profile whose local workspace key
differs. The page resolves `workspaceid` to the local workspace entry for the
signed-in identity. Restricted placeholders offer no reference. If the clipboard
is denied or unavailable, a dialog shows the Markdown link and URL for manual
copying instead of reporting success. Losing access closes that dialog and clears it.

Opening a reference is an ordinary authorized canvas load. After the first
authorized snapshot, the target is selected, centred in a viewer-local viewport,
restored if minimised, focused and briefly highlighted, exactly once per page
load. The centred view is not written to the canvas viewport; it lasts until the
viewer pans or zooms. Missing, restricted and malformed targets show one neutral
message and the canvas still opens. Chat Markdown leaves same-origin `.html` page
links such as `/canvas.html` untouched instead of normalizing them as shell
routes. See `docs/canvas-references.md` for agent resolution.

## Document discussion in naplets

Document readers expose **Document comments**, within the document reader. The panel reads and creates roots and replies through the
existing typed `/docs/:docId/comments` routes. Accepted rows use the existing
PG document-comment mapper and Dexie `comments` table, so open readers and the
Documents surface share records. Each naplet retains its own draft, selected
anchor and reply target; comments never alter the document body or take checkout.

The discussion is a right-hand Docs-style sidebar with a thread count,
add/collapse controls, thread cards, replies and a composer. Document and
sidebar content have independent scrolling. Below 720px of reader width,
the sidebar becomes an opaque right-side overlay with a dismissible backdrop;
it never becomes a bottom stack. Collapse, Escape and backdrop dismissal retain
mounted drafts, and the collapsed rail reopens the discussion. Fullscreen and
window restoration retain both reading and discussion scroll positions.

**Comment on selection** captures the read-only TipTap selection with the Docs
anchor helper. An empty selection creates a whole-document comment. Replies
inherit their root's anchor metadata, and **Show selected text** uses the same
quote/offset relocation and stale-anchor feedback as Docs. Author identities and
local date/time labels accompany roots and replies. Text is rendered as text.

A fresh signed comment read gates the local projection. Refresh and window focus
reconcile current threads; there is no additional broad shell subscription or
background polling. Existing cache entries absent from that read remain hidden,
while accepted rows arriving during or after hydration appear through liveQuery.
The existing endpoint returns at most 200 comments without pagination; a full
page explicitly reports this limit. This is not a complete-history guarantee.

Failed writes retain the draft and expose server feedback. Retry first checks
the same client record identity against fresh comments to avoid duplicating a
write whose response was lost. A full page that cannot confirm an earlier send
blocks blind retry. Drafts are local to the mounted reader, survive closing the
panel, and are cleared when the source changes, access is revoked or the reader
is removed; they are not durable across page reloads. Removing a reader disposes
its subscription and focus listener and invalidates late asynchronous results.

Focused unit tests cover authority gating, stale cache, reply metadata, uncertain
send reconciliation, permission errors, initial-query races and source disposal.
The signed synthetic browser scenarios cover desktop/phone reading, replies,
whole-document and anchored comments, reload, two-reader updates and denied draft
retention. They do not establish authenticated multi-actor Tower permissions or
physical Safari/touch behavior.

## Responsive toolbar

The canvas toolbar is one non-wrapping horizontal row bounded to its viewport,
including embedded panes. Naplet adds (Chat, Task Tree and Add naplet) lead the
scrolling controls. The title is capped at 180px (80px on phones); its hover
tooltip exposes the full title without displacing controls. Keyboard focus
scrolls later controls into view. Words, Arrows, Frames and Groups remain,
alongside selection, hand, zoom and editing controls. Legacy shapes and strokes
still render and can be selected and edited, but have no creation tools or keys.

Native canvas comments have been removed. Snapshot normalization ignores older
server comment payloads and Dexie version 44 removes cached snapshot comments.
Document comments and chat-thread naplets retain their independent paths.

`tests/e2e/canvas-toolbar.spec.cjs` checks 320–2048px widths, long-title tooltip,
non-wrapping groups, leftmost adds, keyboard focus scrolling, zoom, panning and
embedded pane resizing using synthetic Tower records.

## Refresh work

Simultaneous read-only refresh callers share one queued snapshot read. Enqueuing
a mutation ends that sharing epoch, so a later refresh cannot reuse a snapshot
from before the write. Writes and their authoritative refresh remain serialized.
The direct refresh completion and Dexie observer publish a committed request ID
once per runtime, avoiding duplicate full UI reconciliation. Stop invalidates
pending work and resets publication identity; resume obtains fresh authority.
Snapshot payloads and per-source authorization remain unchanged.
