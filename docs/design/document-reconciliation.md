# Document drafts and version review

The editor keeps its working copy in the workspace's local `document_drafts`
journal, separately from the canonical document row. It retains the complete
starting body and canonical row version, version identity, storage identity and
body hash. New shared saves cannot replace a divergent editor buffer.

Returning to the page, reconnecting, and publishing a changed document make an
independent typed body read. A cached preview or failed read cannot satisfy this
check. A changed or unverifiable base pauses publication and shows **Review
changes**. Permission failures and unavailable documents preserve local work.
Tower still performs the final atomic version/hash and permission checks.

Review compares the local working title/body with the latest saved version.
**Accept latest** requires an explicit dirty-draft replacement confirmation,
rechecks the latest head and loads that saved version without publishing a new
one. The replaced complete draft remains in the local journal's preserved-copy
archive. **Previously replaced drafts on this device** can display and resume
it. Ordinary undo, successful saves and current-draft removal do not remove
these archived copies. They are local to this browser/workspace database;
clearing browser data removes them.

**Merge my changes** uses the verified common saved base. A dedicated browser
worker compares the rich editor tree, retaining text, whitespace, marks, links,
attachments and structure while ignoring editor bookkeeping identities for
comparison. The resulting tree retains block identities for existing comment
anchors. Bounded
sequence diffs combine independent edits. Overlaps and bounded-diff exhaustion
require explicit local/latest choices. A missing or unverifiable base permits
comparison but disables automatic merge. No two-way comparison is presented as
a common-base merge.

Applying a resolved merge checkpoints its complete result and original draft
before changing the editor, moves the save base to the reviewed latest head,
and opens the ordinary rich editor. Automatic cloud saving remains paused until
the user explicitly saves the result. A successful CAS save creates the next
canonical version. Later typing during a save remains dirty. A head change
before acceptance, merge application or publication preserves the draft and
previous merge preview and requires another review. Closing review never
publishes or discards the draft; choices survive reopening when the compared
copies are unchanged. Earlier merge previews remain readable when a refreshed
review changes the compared copies.

## Concurrent editing capability

Tower lease inspection retains `document_edit_protocol` for legacy compatibility
and advertises `document_edit_protocols`. The browser prefers
`document_concurrent_edit_v1` only when advertised. Acquisition sends that marker
with the visit's UUID `editor_session_id`; acquisition and renewal must echo the
selected marker and matching session. A silent downgrade is rejected, and the
unconfirmed token is released. Canonical PATCH continues to use the existing
lease token, row version, body hash and version identity. No authorization or
version check is bypassed.

Concurrent sessions neither revoke peer sessions nor create an authority-barrier
version on acquire. Takeover is unavailable in this mode. Older Towers keep
exclusive `document_edit_session_v1` editing; fallback is never described as
concurrent. Legacy and concurrent modes cannot mix while leases are active:
legacy leases must release/expire before concurrent acquisition; active
concurrent leases block legacy acquire/takeover. Bots use the same advertised
protocol, permissions and CAS rules; Tower's
`docs/contract/document-concurrent-edit-v1.md` documents their API sequence.

Client source delivery does not activate Tower or install native clients.
Authenticated multi-user/browser/native interoperability requires the matching
Tower capability to be served. Android remains a separate parity follow-up.

## Verification

`tests/document-three-way-merge.test.js` covers rich common-base merges,
independent edits, overlap choices, deletion, insertions, bookkeeping and bounded
fallback. `tests/docs-manager-mixin.test.js` covers v6 drafts versus v8, accept
without publication, durable replaced copies, editable v9 merges, review races,
changed merged drafts, missing bases, failed reads and stale navigation.
`tests/pg-edit-session.test.js` covers capability negotiation, echo validation,
legacy fallback and mixed-mode refusal. The served-browser reconciliation suite
exercises the real worker and rich editor, native text entry, acceptance and
remote advance during review using isolated synthetic records. These fixtures
exercise client orchestration rather than authenticated multi-user acceptance.
