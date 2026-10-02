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
are independent roots. Siblings sort by `sort_order`, then ID. Subtree spans
place parents over descendants; parent edges join node boundaries. No saved
coordinates or separate tree entity exist. Collapsing affects presentation only.
The controller keeps the complete layout and limits rendered nodes/edges to the
viewport when zoomed in. Fit, zoom, pointer pan and wheel pan are local controls.
Arrow keys traverse visible preorder, collapse/expand or visit parent/child;
Home/End move to endpoints and Enter/Space selects. Keyboard reveal restores
readable zoom for tiny fitted deep/wide forests. Mobile stacks references below
the canvas; the panel and page remain scrollable outside the pan surface.

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
ACL-checked metadata. The validated HTTP(S) origin opens the ordinary artifact
site, where the user chooses the artifact's latest version. Local Artifact WApp
`catalog-routing.js` currently parses only versioned artifact paths; no supported
unversioned/latest deep link exists. WP3 does not invent one, fix a version,
fetch a private cross-origin catalog, or change the WApp. WP4 must establish an
approved follow-latest opener before direct artifact navigation can be enabled.

WP4 extends the controller/template with the already accepted service commands
and permission/conflict UX. It must not persist view selection or expansion or
introduce optimistic destructive writes. WP2's cache, coverage and resolution
stores stay authoritative; WP4's editing uses the existing `context.*` command
port and delete preview. Browser fixtures verify this source view, not live Tower
activation or second-client convergence, which remain WP6.
