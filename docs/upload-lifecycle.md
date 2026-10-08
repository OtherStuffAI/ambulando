# Browser upload ownership and retry

Storage prepare, transfer, metadata reconciliation and completion retain the
initiating workspace/backend. Inline source inputs also capture document/task,
editor generation and comment/block selection. Rich paste results belong to the
captured adapter/editor. A late result must never replace another editor's text,
checkpoint another document or create a file with destination workspace authority.

Chat attachment retries retain the prepared object and transfer acknowledgement
in the source draft. After an uncertain completion response, retry first reads
that object's metadata from the selected backend. A completed object must match
object id, byte count and source SHA-256. An incomplete object reuses Tower's
existing idempotent completion operation; a failed metadata read stops the retry.
Retry state stays out of outbound message attachments. It is in-memory draft
state, not a promise of recovery across browser reload.

Removing an attachment aborts its client request signal, prevents later stages
and suppresses accepted late completion. It does not delete source bytes, remote
objects or unrelated drafts. Cancellation is bounded by the selected transport's
AbortSignal support; it cannot undo an already accepted backend request. Unknown
prepare results without an object id and remote orphan cleanup still need backend
reconciliation/retention policy before stronger guarantees can be made.

Document draft reads/writes retain their captured Dexie handle while opening or
committing. Navigation/logout detaches the active handle immediately, and the
last draft operation closes the obsolete handle. No schema, cache-clearing or
cursor recovery is involved.
