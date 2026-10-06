# Channel notebook pages

Channel Docs can open a shared home page. Open a document and choose **Set as
home** to set or replace it, or **Clear home** to return to the list default.
**Home** and **All docs** stay available above the editor and list on desktop
and mobile. All docs here retains the channel context; the existing All documents
control opens the workspace-wide browser. Deleted, archived or unreadable home
pages fall back to the channel list. A channel without home retains list behavior.

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
