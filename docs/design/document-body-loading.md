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
