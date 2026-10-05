# Read-only Context Tree browser (WP3)

The `context` section follows the selected PG scope (`pgContextScope`, with the
existing board-scope fallback), preserves the scope in the ordinary route and
uses the normal shell navigation. The browser owns no Tower hierarchy records,
SSE connection, polling loop or editing controls.

`src/context-tree-view.js` is an Alpine data controller registered in `main.js`.
`queueSync` watches shell identity, then binds `observeContextScope` to the
currently open workspace database. Scope/workspace changes unsubscribe and
reset local selection, focus, collapsed IDs and transforms. Section destruction
and workspace/sync-service shutdown suspend the view. Starting workspace live
queries resumes a mounted view even when reconnecting the same workspace. Late subscription/load results are
ignored by generation and selection tokens; a deleted selection becomes a
neutral notice. Denied/error views conceal cached structure.

`src/context-tree-layout.js` is a pure iterative forest layout. Parentless rows
are independent roots. Siblings sort by `sort_order`, then ID. The same visible
preorder drives both presentation modes; hierarchy rows and parent pointers are
never changed by viewing, collapsing or switching modes.

Outline is the default work-breakdown view: normal-size wrapping labels, capped
indentation for very deep paths, connector guides, child/reference counts and
separate disclosures. Measured row heights and overscan spacers bound the DOM to
the visible scroll window without imposing a fixed height on wrapped text.
Programmatic reveals wait for committed DOM geometry and suppress older native
scroll notifications until the next frame. Scrolling the focused row out of the
window restores the tree container tab stop for keyboard re-entry.
Native vertical scrolling works on touch screens. `aria-level`, `aria-posinset`
and `aria-setsize` describe the full visible hierarchy even with windowing.

Visual places deeper levels to the right and siblings vertically. Subtree heights
keep cards apart; long labels reserve extra card height. Initial framing opens
at normal readable scale at the first root rather than fitting every branch.
Fit has an 85% minimum; larger trees remain pannable. Zoom, pointer pan and wheel
pan controls appear only in Visual. Numeric edges remain viewport bounded.

The explicit Outline / Visual toggle preserves selection, focus and collapsed
IDs and shares the existing reference/detail panel and editor. Only the view
preference is persisted in localStorage (`flightdeck.context-tree.view`); invalid
or inaccessible storage falls back to Outline. Scope/workspace changes still
reset hierarchy selection/collapse and transforms. No component IDs, target data
or authority decisions are stored with this preference.

Arrow keys traverse visible preorder, collapse/expand or visit parent/child;
Home/End move to endpoints and Enter/Space selects. Search includes collapsed
components and reveals every ancestor of the chosen result in either mode.
Keyboard/search reveal scrolls the Outline window or pans Visual into view.
Mobile stacks references below the tree; the panel and page remain scrollable.

Structure and reference loads use `TowerSyncService.ensureLoaded` exclusively.
Expansion never fetches. Direct references come from the selected component's
cached links. Their display titles come only from matching-version ACL-checked
resolutions, never document bodies or cached source titles. Resolution is checked
again before opening; ordinary target routes remain the authority. `doc` is the
canonical record-link type, mapped by the existing mention opener to the normal
document viewer; `task` uses the existing task viewer. PG `file` maps through the
existing `mapPgFileToLocalDocument` cache representation. The normal authorized
file-list recovery and file download opener recheck listing/storage access;
missing or revoked files remain unavailable. No document body is rendered or
copied into the component panel.

Artifact descriptors display the project/artifact and latest policy without claiming
ACL-checked metadata. WP4 adds the verified WApp-owned unversioned opener and
editing; see [context-tree-editing.md](context-tree-editing.md) for the route,
authority, conflict and source/runtime boundaries. The WApp owns authenticated
catalog resolution; Flight Deck never fetches private cross-origin catalogs.

WP4 extends the controller/template with the already accepted service commands
and permission/conflict UX. It does not persist component selection or expansion or
introduce optimistic destructive writes. WP2's cache, coverage and resolution
stores stay authoritative; WP4's editing uses the existing `context.*` command
port and delete preview. Browser fixtures verify this source view, not live Tower
activation or second-client convergence, which remain WP6.
