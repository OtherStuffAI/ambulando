# Channel notebook pages

Channel Docs can open a shared home page. Open a document and choose **Set as
home** to set or replace it, or **Clear home** to return to the list default.
**Home** and **All docs** stay available above the editor and list on desktop
and mobile. All docs here retains the channel context; the existing All documents
control opens the workspace-wide browser. Deleted, archived or unreadable home
pages fall back to the channel list. A channel without home retains list behavior. Each native Docs entry opens Home,
even when Docs is already selected or another page is open. All docs is an
explicit route choice (`docsview=all`) that survives reload; direct document and
folder routes retain their targets. The active shell in `src/shell-state.js`
owns these navigation and route methods; inline `src/app.js` methods are fallback
defaults overridden during store assembly.

The shared reference is `channel.metadata.docs_home_document_id`, a document ID
or null. Flight Deck writes only this key through the existing Tower channel
PATCH command. Tower merges other metadata and enforces `channel.manage`.
The normal materialization and channel Dexie table carry the accepted reference
to other devices; browser navigation state does not authorize or store home.
No schema migration or backend service change is required.

## Links in rich and source documents

Type `[[` in prose to open the channel-local picker. Type a title to filter, use
Up/Down and Enter to choose, or click a result. Escape dismisses it. Results
include a short ID to distinguish duplicate titles. **Create “name”** creates a
page in the originating channel, inserts its link, saves the originating page,
then opens the empty titled page in a focused rich editor ready for typing. While creation is pending, repeated actions are gated and the originating editor
pauses text entry until the link is inserted or the error is reported.
If origin save fails, the page remains created and the link/draft stay open;
retry Save, then follow the link. Errors appear through the normal app error UI.

Links have a dotted underline. Click or tap a link in read or edit mode to open it. No Ctrl/Cmd modifier is
required. Dragging retains native selection without navigating; a focused link
also supports Enter or Space. The existing local document draft
path preserves unsaved work before navigating. Browser Back restores the previous
page through the existing document route and draft restoration.

Canonical source is ordinary Markdown with a `wiki:` destination:

```markdown
[Plant list](wiki:550e8400-e29b-41d4-a716-446655440000)
```

The ID is authoritative; the label is a saved fallback. Rendering looks up the
current readable channel-local title, so renaming preserves navigation. Deleted
or inaccessible IDs remain visibly unavailable and are never reassigned by title.
Existing agent document create/update tools can put canonical links in their
Markdown content without a new tool. Escape Markdown brackets and backslashes
in labels as usual. Links are scoped to the document's channel, not all workspace
documents; they do not confer access to the target.

Pasted or agent-authored `[[Plant list]]` is a title-only link. A unique,
case-insensitive exact title in that channel binds to its document ID when the
content is edited/saved. A missing title stays visibly unresolved and offers
creation on click. An ambiguous title stays marked **choose page**; choose the
specific page from the picker rather than silently selecting a match. Wiki syntax
in code blocks and inline code stays literal. Canonical links survive rich/source
roundtrips and retain their IDs in the saved ProseMirror JSON and Markdown body.

## Validation

`tests/wiki-pages.test.js` covers resolution boundaries, source roundtrips,
create/save/open ordering, repeated-click gating, errors, draft preservation and
shared home updates. `tests/wiki-home-materialization.test.js` verifies that the
shared reference survives channel materialization and a fresh store read. `tests/e2e/wiki-pages.spec.cjs` exercises the native Tiptap
picker, selection, navigation and mobile controls using synthetic readable rows.
Run browser tests against the configured managed Flight Deck URL with a local
Tower. Existing document editor, comment-anchor, mention and diff tests remain
part of the full regression suite.


Draft checkpoints rebuild source input instead of reusing a prior rich model,
including deliberately empty source. A pending local draft read cannot replace
fresh typing or a changed workspace/document. Equal compatibility Markdown does
not justify deleting a draft with different rich editor state. Home and All docs
cancel delayed entry when document, channel, workspace or navigation ownership
changes. Returning to an already open home preserves the mounted dirty editor.


Pages mount a rich editor immediately. Focusing, selecting or following a link
alone does not acquire a PG edit lease; actual input starts acquisition. Typing
while access is checked remains a local draft; canonical saves still require
Tower's lease and ACL checks. A denial preserves the draft and exposes Retry.
Rich mode can also reopen without an Edit step; source and block modes retain
their explicit edit-access gate.

Creation immediately shows **Creating page…** and disables wiki links for click,
touch and keyboard until success or failure. The empty target editor focuses
without waiting for a target lease. Origin access, storage upload, create
reconciliation/POST and origin save remain awaited canonical operations. The
in-memory `wikiCreateTimings` records elapsed milliseconds at origin access,
page persistence, origin save, editor focus and completion, without page text
or identities. These timings distinguish where a slow request spends time;
fixture timings do not establish live network latency. There is no fixed
creation sleep. Body hydration has separate bounded retries (0/1/3/7 seconds)
and remote autosave has a 15-second debounce; explicit creation save bypasses
that debounce.

The collapsed **Backlinks** bar at the bottom lists incoming references from
readable, materialized pages in the current channel. It excludes the current
page and deleted/archived sources, deduplicates source IDs and resolves unique
title links without guessing ambiguous titles. Rich JSON and canonical Markdown
are supported; code literals are excluded. Parsing is cached by row and content
identity. Sources whose bodies have not yet materialized cannot contribute
links until they load. Opening a backlink uses the same draft checkpoint and
navigation path as a forward link. The panel resets on document changes.
