# Document body loading

Document detail opens from local materialized records and reconciles the complete
Tower body in the background. Metadata and an editor model created from metadata
are not evidence that a storage-backed body has loaded.

The selected-document hydration loop must validate `record_id` before testing
body readiness. Sync can return a deferred acknowledgement during authority
replacement; that acknowledgement has no storage object and must not be treated
as a complete document. Existing bounded reconciliation continues against the
selected row, while visit/workspace guards reject stale results.

Body hydration can complete without changing the document row version. The
editor observes this transition when its initial body was incomplete, applies
content in place, and records completion so a reactive update is idempotent.
Dirty/restored drafts remain authoritative for the editor and cannot be replaced
by a same-version completion. Newer versions retain existing conflict handling.

Cross-channel record opening selects channel context with `preserveDetail`.
Ordinary board navigation can asynchronously close an open detail after a paint;
following a document's owning channel must not trigger that lifecycle.

Rich editor mounting reports loading and failure separately from edit lease
access. A failed asset load exposes Try again and Read without editor. The latter
uses the existing block preview and remains usable even when the browser caches
an unsuccessful module fetch. Body failures expose a connection-aware message
and an explicit same-document retry; local drafts must be preserved first.

## Regression coverage

`tests/docs-manager-mixin.test.js` reproduces the deferred acknowledgement and
same-version hydration transitions. Existing coverage protects late visits,
workspace changes, dirty drafts and draft restoration ordering.

`tests/e2e/document-loading.spec.cjs` uses the served app with isolated synthetic
records and native clicks. It covers repeated warm opens, delayed cold body
completion, stale responses, a cross-channel document mention whose first body
read is deferred, editor asset failure with readable fallback, and explicit body
recovery on the same selection. Service workers are blocked so asset failures
can be intercepted reliably. These checks validate browser orchestration; they
do not establish authenticated access or the cause of a particular historical
browser screenshot.

## Save base and recovery behavior

The editor retains the canonical row version, version identity, storage object
and body hash separately from its mutable content. A same-version body metadata
completion may repair that base without replacing the editor buffer. A local
draft missing its base hash can recover it only when its recorded complete-base
content signature, storage object and row version match the fully loaded
canonical body. Older or unverifiable bases continue through recovery handling.
Embedded canonical metadata survives fallback from the typed body route to a
storage download.

Dirty detection compares the editor tree, including marks, links, structure and
exact text, while ignoring only `fdBlockId` and `pmNodeId` bookkeeping. ID repair
keeps the first unique identity for comment anchors and repairs copied IDs.
Serialization integrity checks still reject incomplete save models. Discovery
of a separate recovery does not change the base of an unopened canonical editor.

Local drafts retain the last recovery submission signature independently of
later editor checkpoints. Equivalent retries do not submit again; new edits
remain eligible for preservation. Opening a recovery that matches the loaded
saved document explains that the user can discard the recovery while keeping
the saved document. Resolution remains an explicit user action through the
existing Tower recovery endpoints.

Undoing to canonical content deletes the previous local draft; undoing to an
already preserved recovery checkpoints that recovery body and its metadata.
Draft puts/deletes execute in input order against the database captured before
an asynchronous boundary, and reads wait for those writes. Completion updates
are guarded by editor generation and write revision so navigation cannot apply
an old draft to another selection. Undo therefore remains durable when an older
put is already in flight, including across a workspace switch.
