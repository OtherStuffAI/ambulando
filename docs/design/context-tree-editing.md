# Context Tree editing and reference linking (WP4)

The browser extends the WP3 automatic forest and direct-reference panel. Readers
retain the view; every editing control and controller entrypoint requires the
current context coverage's `capabilities.manage === true` and a complete scope.
Tower remains authoritative for `scope.manage`, scope/target visibility, parent
validation, row versions, deduplication and delete concurrency. A hidden control
or cached capability grants no backend authority.

`context-tree-editor.js` owns local drafts, confirmations and the picker.
`context-tree-view.js` retains lifecycle/generation guards and Dexie liveQuery
rendering. All mutations call `TowerSyncService.command('context.*', input)`;
there are no optimistic hierarchy rows, document copies or pending/offline writes.
Create/rename/reparent await acknowledgement plus canonical worker reconciliation.
An acknowledged created component becomes selected and revealed only after its
canonical row appears. This keeps mobile additions visible without phantom rows.
The submit guard survives lifecycle resets while a command is pending. Missing or
stale acknowledgements and transport errors never report success. Reload the
current context before retrying an uncertain write.

Parent choices include Top level and exclude the edited component and all its
descendants. Only the edited root's title/parent/version is submitted; its subtree
and reference rows remain server-owned. There is no hierarchy drag/drop.

Delete preview uses only `ensureLoaded('context-delete-preview', componentId,
{scopeId,force:true})`. The confirmation displays exact descendant/reference
counts and explicitly says linked content remains. Cancellation sends no delete.
Confirmation supplies that preview's token; 409 removes the old preview and loads
new counts/token with a conflict notice requiring another explicit confirmation.
No offline preview or deletion is queued. Unlink is independent and submits the
reference's expected row version, with no referenced-content mutation.

The reference picker reuses current `channels`, `channel-documents`,
`channel-tasks` and additive `scope-tasks` service reads. Users can choose another
channel or a scope-owned task in the same workspace. Fresh ACL-checked browsing
IDs bound the picker; titles render through liveQuery over the normal documents
and tasks tables, filtered by workspace, type and active state. Denied/failed
browsing clears candidates. Existing bounded list browsing limits apply; the
picker is not a new exhaustive search API. Attachment rechecks target ACLs on
Tower and never grants access. `doc` is the canonical Tower/record-link name;
the existing mention dispatcher opens the normal document viewer. Tasks use the
ordinary task viewer. Files use current authorized listing/storage download.
Reference titles come from matching-version context resolution; unavailable
records remain neutral. Opening rechecks resolution and the normal target route.

Artifact descriptors remain `{origin,project,artifact,page:'index.html',
version_policy:'latest'}`. `context-artifact-link.js` validates HTTP(S) origin,
credentials/path/query/fragment and 1–128 ASCII slug characters, canonicalizes
origin, and constructs the **supported Artifact WApp** unversioned route:
`/artifacts/:project/:artifact/`. The WApp resolves `index.html` against its own
normal authenticated catalog on each navigation and records the resolved version
in the displayed route. Omitted/private targets stay behind normal sign-in or
neutral unavailable states; no fallback selects an unrelated artifact. Explicit
versioned WApp links remain pinned. Flight Deck does not fetch private cross-origin
content or catalogs. Source support in both apps requires separately authorized
activation before hosted behavior can be claimed.

WP5 can use the unchanged Tower typed targets/commands and concurrency tokens.
WP6 owns migration/runtime activation, served assets, live ACL/catalog checks and
two-client convergence. Unit/browser fixtures and disposable Tower/WApp round
trips establish source behavior, not activation. Jobs/apps remain deferred.
