# Context Tree synchronization and cache (WP2)

Tower's canonical `context_component` and `context_reference` families recover
through `/records`, its bounded snapshot/delta cursors, journal tombstones and
scope visibility. Their payloads follow `context-tree-v1-api.md` in Tower;
reference `scope_id` is server-owned. Stored targets have no resolution/title.

Dexie v31 adds `context_components`, `context_references`, `context_coverage`
and ACL-checked `context_reference_resolutions` without replacing existing
stores, drafts, writes or cursors. PG registry entries use Tower transport;
there are no encrypted compatibility families for this structure.

`pg-record-delta.js` stages canonical rows through the existing materialization
worker. Context projection publishes both stores in the terminal catchup
transaction, after every page and snapshot handover is present. An interrupted
catchup retains the previous coherent tree and resumes its committed cursor.
Root/descendant/link tombstones cannot settle as partially deleted structure.
Missing, cyclic or cross-scope parent chains and orphan references are excluded.
The snapshot omission walk leaves context stores alone until the atomic terminal
projection. Authority resets immediately hide context, including preserved-view
resets, while existing non-context recovery rules remain unchanged.

`observeContextScope(db, workspaceId, scopeId)` supplies a transactional Dexie
liveQuery for WP3. The consumer must retain the existing workspace disposal
and selection guards. It exposes `unloaded`, `loading`, `complete`, `denied`
and `error`; empty is true only for a complete scope with zero components.
It never derives target access from stored identifiers.

Service entrypoints (no UI-owned SSE or timer):

- `ensureLoaded('context-tree', scopeId)` checks the typed scope route/capabilities
  and requests worker-owned workspace recovery. A stale runtime without both
  registered context families fails as unavailable/incomplete, not empty success.
- `ensureLoaded('context-references', componentId, {scopeId})` walks the typed
  ACL-checked reference route. Resolution is cached only for matching row versions,
  cleared before reloading and whenever authority changes/reset occurs. Opening
  still requires the ordinary target route. `doc` maps to the existing `document`
  opener in WP4; no body is copied.
- `ensureLoaded('context-delete-preview', componentId, {scopeId})` returns the
  explicit concurrency preview for the later confirmation UI.
- `command('context.create|update|attach|unlink|delete', {scopeId,componentId?,
  referenceId?,body}, options)` uses service command descriptors and the PG write
  adapter. Unlink carries JSON `expected_row_version`; delete carries a supplied
  `confirmation_token`. There is no optimistic hierarchy or destructive offline
  queue. Acknowledgement is followed by canonical recovery; write acknowledgement
  alone does not establish convergence.

Existing SSE hints trigger workspace recovery, bypassing replay-delta suppression
for context events. Events include mutation/scope/component hints, never target
metadata. Worker ownership, reconnect and disposal remain the existing lifecycle.

Fixture validation uses synthetic rows from the reviewed Tower WP1 examples.
`context-cache-lifecycle.spec.cjs` uses a populated v30 IndexedDB, the real worker,
liveQuery and intercepted loopback fixture URLs; it starts no application runtime
and contacts no Tower. It exercises upgrade, interrupted multipage catchup,
second-client changes, split deletion, scope omission/revocation and workspace
isolation. This proves fixture convergence only. Tower migration/runtime and
served browser activation plus live two-client validation remain WP6.
