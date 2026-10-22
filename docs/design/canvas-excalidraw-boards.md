# Canvas Excalidraw boards

Add naplet → **Excalidraw board** offers **Create board** (creates a persistent private board and
links the naplet immediately) or **Link existing board**. The board is a Flight Deck File; naplets
store only `{ source: { type: 'excalidraw', id: <file id> }, layout }`. Several naplets and canvases
may reference one board. Agent usage is documented in `docs/excalidraw-boards.md`.

## Authority and storage

No board, version or ACL tables are added. A board reuses Tower's Files:

| Need | Tower route (signed NIP-98, same for browser and agents) |
|---|---|
| Create board (v1) | storage prepare/upload/complete → `POST /channels/:channelId/files` |
| History, authors, latest pointer | `GET /files/:fileId/versions` |
| Explicit Save (atomic CAS) | `POST /files/:fileId/versions` with `base_version_id` → `409 stale_base_version` |
| Exact version bytes | `GET /files/:fileId/versions/:versionId/object` (`file.read`, non-disclosing 404) |
| Naplet projection | Canvas snapshot `source.type = 'excalidraw'`: metadata only (current version id/number, sha256, `can_write`) |

The canvas snapshot never carries scene bytes. Tower re-authorizes the File for every snapshot and
returns the generic denied naplet when the viewer lacks `file.read`. Canvas visibility grants no
board access. The narrow Tower addition this client needs (`excalidraw` naplet source type plus an
optional version `summary`) is specified in the task handoff; until it is deployed, linking a board
to a canvas is rejected by Tower and the client reports that the board was saved but not linked.

## Canonical scene

`src/canvas/board-scene.js` defines the stored document: a standard `.excalidraw` JSON with every
element (including `isDeleted` tombstones), element `version`/`versionNonce`, unknown Excalidraw
fields, the board-level `appState` subset and embedded image `files` referenced by any element.
Viewer state (zoom, scroll, selection, theme) is never stored. Public exports
(`exportPublicBoardScene`) are a separate lossy projection. Because element identity and versions
survive, `rebaseBoardScene` can merge a stale draft onto a newer version by element id, and a later
live-collaboration layer can reconcile the same data.

Images are embedded as data URLs, so the board's single `file.read` check covers every image and an
immutable version renders exactly as saved. Limits: 6 MiB per image, 200 images, 24 MiB per version.
Each version stores its images again; externalising images to sibling Files (as HTML artefacts do)
is a possible later optimisation that the stable Excalidraw `fileId`s allow.

## Sync boundary and local state

- `CanvasBoardRuntime` (`board-sync.js`) is the only board network owner: signed typed File routes,
  digest-verified version reads, uploads and CAS saves. Saved scene bytes are cached in memory only,
  bounded to 24 entries and 64 MiB.
- Unsaved drafts live in Dexie `canvas_board_drafts`, keyed by the canvas authority partition
  (backend, Tower/service/app authority, workspace, viewer, actor, database key) plus File id, and are
  observed through `liveQuery`. A draft records its base version, so reopening restores it.
- `BoardController` (`board-controller.js`) owns one board on a page: it loads the latest version,
  restores drafts, mirrors edits between editors, saves explicitly, handles stale saves, merges,
  history browsing and restore. Alpine renders its state; Alpine never calls the network.

## Editor surface

Each board naplet hosts a same-origin `canvas-board.html` iframe that lazy-loads React and Excalidraw
(fonts self-hosted under `/excalidraw-assets/`, no CDN). An iframe is used because the canvas stage is
CSS-scaled; browsers map pointer events into iframe coordinates, so drawing stays accurate at any
canvas zoom. It also isolates Excalidraw's keyboard shortcuts and wheel handling from the canvas.

The page and editor communicate over a private `MessageChannel` established after the iframe loads
(origin and source checked). The editor owns no network or storage. It reports changes only after real
user input, so Excalidraw's load-time normalisation never marks a board unsaved. Embeds are disabled
and element links open only `http(s)` URLs in a new `noopener` tab.

Full screen promotes the same naplet dialog with `showModal()`, keeping the iframe and its Excalidraw
instance alive: inline and full-screen editing are one session with one undo history. Two naplets for
the same board on one page share the controller's draft and receive each other's edits. Other tabs
receive the draft through Dexie `liveQuery`.

## States and actions

There is no version strip. The naplet title bar carries a compact status: `vN`, `Unsaved · vN`,
`Saving…`, `Save failed`, `Unsaved · newer vM saved`, `Viewing vN · read-only`, `Read-only · vN` or
`No access` (its tooltip adds the longer save and version labels). All version controls live in the
cog menu.

- **Save** floats over the drawing area. The page posts its state (`Save`, disabled `Saved`,
  disabled `Saving…`) to the editor iframe, which renders it in Excalidraw's own top-right slot on
  desktop and, on Excalidraw's phone layout, just below the tool row and left of the side tool
  column, so it never covers a tool. It is hidden while viewing an older version and for viewers
  without `file.write`. A click only asks; the page re-checks the current state before saving.
- **Save board version** and **Save with note…** remain in the cog menu and publish one immutable
  version against the draft's base. There is no autosave.
- Save first asks every editor to flush its 250 ms change debounce and waits for the change to reach
  the draft, so a stroke immediately followed by Save is included. Editors also deliver a change
  right after each pointer-up or key-up. Publication needs every attached editor's acknowledgement
  plus the applied change; if an editor does not answer within 3 s or closes first, nothing is
  posted, the draft stays dirty and Save shows a retryable error. A second Save while one is in
  flight is ignored.
- **Load latest saved version** asks Tower for the File's current head (the version list), not the
  possibly older canvas snapshot, so it never reloads an obsolete version after a stale save.
- Refreshing loads a newer saved version automatically only when there are no unsaved changes.
  Otherwise the draft is kept and **Merge latest** or **Discard draft** is offered; discarding asks
  for confirmation. Leaving the page with unsaved changes triggers the browser's warning (the draft
  also survives locally).
- A stale Save keeps the draft (`Newer version saved`). **Merge latest** rebases it by element id and
  leaves the result unsaved for review.
- **Versions…** (cog menu) opens a versions dialog, as for HTML naplets: Older / Newer and a version
  list (number, author, time, summary) browse versions read-only. **Return to latest** resumes the
  draft, and **Merge latest** appears when a newer version exists; both are also direct cog items
  when they apply. **Restore as draft**
  turns an older version into an unsaved draft on top of the latest, re-stamping element versions
  so the restore wins later merges.
- Viewers without `file.write` get a read-only editor.
- If Tower denies the board (revocation, deletion), the controller discards the local draft and
  cached bytes and clears the editor.

## Verification

`tests/canvas-excalidraw-boards.test.js` covers scene canonicalisation and limits, runtime routes,
explicit save, stale rejection with draft preservation, merge, refresh, draft restore, image
round-trip, history and restore, read-only viewers and revocation purge.
`tests/excalidraw-board-cli.test.js` covers the agent helper end to end against a signed fake Tower.
`tests/e2e/canvas-excalidraw.spec.cjs` drives the real editor in the canvas page. These are client
and protocol checks. Live use additionally requires the Tower `excalidraw` naplet source type.

## Board names

Writable board naplets offer **Rename…**. The native modal dialog starts with the
visible name, selects it for editing, rejects empty/whitespace-only names and
keeps errors visible until a successful save. Cancel and Escape make no request.
Saving uses the existing File PATCH with only `display_name`; it does not publish
a drawing version, change attachments, move the File or alter a naplet or ACL.
Tower rechecks File write permission. Every ready board naplet resolves its
canonical File display name during snapshot hydration (one File GET per distinct
board), so legacy naplet title overrides cannot mask a rename after reopening.
Repeated naplets, their accessible titles, the controller's save filename and
cached source choices update after confirmation. Browser coverage uses a signed
synthetic Tower; a real-workspace permission smoke test remains a review step.
