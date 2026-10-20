# Membership recovery and navigation

Tower's current record checkpoint contract uses a workspace authority epoch.
Group membership changes invalidate previously issued checkpoints, including an
unaffected reader's checkpoint. The client must obey `409 reset_required` and
rebuild from a full snapshot. Successful page progress is recovery, not evidence
of a browser reload or an infinite loop. Server scope existence and local scope
visibility are separate questions.

## Client presentation

The navigation live query reads scopes, channels and the canonical cache's
replacement state in one Dexie transaction. `resetting`, snapshot reconciliation
and retirement mark an incomplete replacement. An empty or partial prefix cannot
prove that the previously selected destination was revoked.

During replacement, retain routing IDs, downloaded content and saved draft
intent. Cached Tasks and Docs remain readable while the authoritative refresh
reconciles in the background; a downloaded destination can be opened directly.
Missing destinations remain routing intent until replacement proves they are
readable. Fence stale asynchronous selection and materialization work without
unmounting cached section chrome or clearing downloaded rows.
Once replacement completes, restore a destination only if current rows still
permit reading it and its scope is present and readable. Navigation during
replacement updates routing intent without mounting a detail editor. Save task
and document drafts through existing local persistence before clearing models;
workspace switches persist them in the old partition before opening the new one. Reconcile missing destinations using normal navigation.
Repeated interruptions must not overwrite saved intent with the empty composer.
A missing selected scope must not broaden the task list to other scopes.

Routine replacement does not render a page-level recovery message. The avatar
activity treatment shows `Syncing`, with detailed progress available from its
profile disclosure. Actionable sync failures and browser re-authentication remain
visible there. A Tasks or Docs foreground refresh failure also remains visible
inside the active section with a retry action; it does not replace cached data
with an empty pane or send a healthy session through login.

This changes presentation only. It does not bypass epoch checks, delay revocation,
retry uncertain writes, clear the entire database or eliminate the initial full
snapshot. Pending commands remain governed by existing conflict/outbox handling.

## Proposal requiring Tower and product approval

Avoiding unaffected-reader snapshots needs a different authority contract, not a
client exception. A possible design binds each checkpoint to a reader authority
generation in addition to the workspace identity. A membership or grant change
would invalidate the generations of all readers whose effective visibility may
change, including nested group members. Unaffected readers could continue their
existing canonical cursor only when Tower proves their effective authority did
not change.

Before implementing, Tower must specify atomic generation updates with ACL
changes, nested-group dependency expansion, workspace revocation, grant additions
and removals, concurrent checkpoint registration, and stale in-flight page
rejection. Unknown dependency impact must conservatively invalidate all affected
readers. New grants must trigger sufficient snapshot reconciliation to discover
previously invisible records. Mixed-version clients need an explicit protocol
migration and must continue to fail closed. Tests must cover two connected
readers, offline reconnect, concurrent ACL edits, newly granted records and stale
responses after revocation. This proposal is not an approved implementation.
