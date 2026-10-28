# Document body record links

The rich document editor's `@` picker reuses the mention catalog for accessible
cached documents, tasks, threads and channels, with `doc:`, `task:`, `thread:`
and `channel:` filters. Bare `@` starts with documents and tasks. Canvas results
reuse the authorized Canvas catalog, partitioned by backend, workspace and
viewer; `canvas:` filters them. Search results from an old editor selection or
workspace cannot replace the current picker. Failed Canvas search leaves prose
unchanged and explains that reconnecting is required.

Document, task and conversation choices insert the existing `fdMention` mark and
serialize as `@[Label](mention:type:id)`. Canvas choices insert the established
`/canvas.html?workspaceid=…&canvasid=…` relative link so new document references also open through the native Canvas route.
Existing absolute Canvas URLs retain ordinary browser navigation in native.
Both retain stable IDs when titles change. Labels are saved fallback text; they
do not automatically follow record renames. Canvas links open the ordinary
Canvas page in a new tab; mention links reuse guarded internal navigation and
its local draft checkpoint. Tower remains responsible for target access and
readable unavailable states. A link never grants permission.

The picker supports keyboard arrows, Enter and Escape and ordinary pointer/touch
selection. Insertion is one editor transaction with an unmarked trailing space;
normal undo/redo, local drafts, autosave and rich/Markdown round trips retain
the existing editor path. Code, emails and selected text do not start a picker.
Existing `[[page links]]` retain their separate picker and navigation.

People and agents are deliberately excluded from this picker. Existing document
saves derive structured actor mentions from body text and Tower emits
`document_mention_added`; exposing actors as link-only choices would conflict
with that existing behavior. Existing saved actor marks and document-comment
instruction semantics are unchanged. Link-only actor references require a
separate owned policy/contract decision before they can be offered safely.

Search is discovery of accessible materialization, not a global search contract:
tasks use the current task collection; documents and conversations also use the
existing local indexes. Canvas discovery needs an authorized online catalog
refresh. Offline drafts and existing links remain readable; unavailable target
reads continue through existing navigation errors without modifying the source.
Android support is a separate follow-up: add the same picker and existing token
formats, checkpoint the document before native target navigation, and test rich
round trips and unavailable/workspace-mismatched targets without adding actors.

Regression coverage lives in `tests/document-record-links.test.js` and the
`document @` cases in `tests/e2e/wiki-pages.spec.cjs`, alongside existing wiki,
draft/autosave and guarded internal-reference tests.
