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

## Offline document editing

Complete cached saved bodies open without a network read. Document updates keep
that canonical cache intact until Tower accepts the write; mutable content lives
in `document_drafts`, including an independent starting body and version/hash.
Offline checkpoints show “Saved on this device · waiting to sync.” Storage-backed
previews and failed body loads stay read-only with retry. Retry exhaustion is UI
state and cannot write an error/preview over a good Dexie body.

Local draft lookup briefly gates input. Differing drafts offer Resume draft or
Read saved version without deleting either copy. This also protects an empty
draft against silently replacing a populated saved body; explicit resumption
retains intentional deletion. Asynchronous editor imports read one current
snapshot after import completion.

Reconnect acquires a Tower lease and makes an independent typed body/head read
before comparing the draft's starting identity. It never joins an earlier
prefetch or treats cached content as a fresh head. Autosave and manual submission
are suppressed throughout that check. Failure leaves the draft local. A changed
head offers explicit preservation in Tower's existing recovery/reconciliation
workflow. Unchanged heads use the ordinary lease and base checks; frontend
optimism cannot bypass Tower concurrency enforcement.

Save uploads snapshot all base fields together. Accepted and recovery responses
apply editor state only to their document, workspace and editor generation;
later typing remains dirty. Canonical acceptance may advance the base of later
edits without replacing their content. These safeguards use existing Tower
contracts and do not remove documents, comments or historical recoveries.

### Validation of the offline editor

The final source validation passed 4,861 tests (one skipped), including delayed
imports, draft restore, upload/navigation/typing races, offline cache reload,
unchanged/changed reconnect heads, failed fresh-head checks and metadata-only
cache preservation. Six served-browser document checks passed, including native
offline typing and explicit draft resumption; seven performance checks passed.
The browser suites use isolated synthetic records and default local Tower targets.
Authenticated multi-user reconnect and the originally reported reproduction remain manual
acceptance checks; historical incident attribution remains unproved.

Final managed-build performance samples, in milliseconds:

| Scenario | Shell / composer | Input p95 | Render p95 | Typing long tasks |
| --- | --- | ---: | ---: | ---: |
| Chat, 200 tasks/docs | 297 / 442 | 0.5 | 32.8 | 0 |
| Heavy chat, 2,000 tasks/docs | 288 / 801 | 0.5 | 215.8 | 0 |
| Diagnostics enabled | 289 / 468 | 0.6 | 148.7 | 0 |

All typing scenarios preserved 74/74 characters. Heavy maximum frame gap was
133.3 ms. Thread/task opening p95 was 158.0/286.3 ms. Against the documented
baseline, heavy render p95 improved from 231.2 ms, readiness from 1,588 ms and
task opening from 499.8 ms. Thread opening is comparable to the prior local
157.8 ms sample. No dropped text or typing long-task regression was observed.
