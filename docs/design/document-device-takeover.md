# Document cloud checkpoints and device takeover

Active browser editors retain the existing 15-second, non-debounced cloud save
interval. Local drafts are persisted separately before network work. Unchanged
content does not upload again; failed PATCH retries retain the prepared storage
identity and compare its hash before reusing it. Retryable failures retry while
the editor remains active. Hiding the page attempts one cloud flush before
releasing authority, with a durable local checkpoint as the fallback. Browsers
may suspend or terminate asynchronous lifecycle work.

Ordinary editing and Save remain compatible with an older Tower. Safe takeover
is available only after Tower advertises `document_edit_session_v1` on lease
inspection. Document acquires send that marker and a random `editor_session_id`.
The session identity survives hidden/visible changes, renewal failure and retry.
Actual document navigation starts another visit. Origin, workspace, app and actor
boundaries prevent reuse of a token or late command acknowledgement.

The explicit **Take over editing on this device** action applies only to a lease
held by the same actor. It freezes the editor, waits for any existing save, and
preserves a divergent local draft through Tower's existing non-head recovery
save (`base_available: false`). Only an acknowledged recovery permits takeover.
The request includes `takeover: true`, the observed `expected_lease_id` and a new
editor session identity. A matching protocol/session echo is required.

Tower serializes takeover with canonical saves, revokes prior tokens and bumps
the document row version as an authority barrier. Superseded session identities
cannot reacquire authority; legacy stale bases become recovery versions. The
browser then reads the complete remote body independently, verifies its returned
version and hash, renews the new lease, and applies title, body and base together.
An unsuccessful load leaves the previous draft and its recovery intact. Older
Tower versions keep normal editing available and expose no takeover action.

Renewal and release responses cannot restore or clear a replacement session's
token. A lost lease stops autosave and preserves the local draft. A superseded
session stays blocked until explicit takeover or a new document visit. Task and
scope lease behavior is unchanged.

Coverage: `tests/pg-edit-session.test.js` checks additive compatibility,
negotiation, explicit takeover, supersession, late responses and connection
identity. `tests/docs-manager-mixin.test.js` checks recovery-before-takeover,
coherent title/body/base load, failure retention, fifteen-second cloud autosave,
o-op saves, typing/renaming during an in-flight save and offline reconciliation.
These are isolated client tests; authenticated multi-device acceptance and live
Tower activation are separate release evidence.
