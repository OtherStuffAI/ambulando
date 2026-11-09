# Document selection comments

Documents offers a floating 44px selection action in the reading preview and
rich editor. It stays outside the document flow, follows viewport/scroll/resize
changes and captures the quote before the comment composer takes focus. Escape
dismisses it; Ctrl/Command–Alt–M opens it from the keyboard. Comment creation does
not replace, remount or save the editor's working copy.

Rich selections map the native DOM range into the raw ProseMirror document,
including table headers/cells and nested marks/links. Reader previews use the
existing block identity and source line/quote metadata; table body coordinates
account for the Markdown delimiter row. Preview selection stays within one
rendered block. An ambiguous or deleted quote must remain unavailable rather
than attach to another passage.

Comments defaults to Active. Resolved contains retained root threads and replies
and exposes Reopen. Active block highlights and counts exclude resolved roots.
The typed Tower PATCH retains the source anchor/body/replies and checks the
observed row version and existing write permissions. A denied status update
keeps the active thread visible; a late accepted response does not clear a newer
unrelated selection/reply draft or materialize into another document/workspace.
No deletion, document edit lease or backend/schema change is involved.

The Apple clients share this comment-status and anchor contract. Native Markdown
reader spans include each table header/body cell, with source lines shared by
cells in the same row. iPhone reader selection uses a native text view and floats
the action in the window so short cells do not clip its touch target. Only an
active selection tracks viewport changes. Mac retains its existing text bridge.
Complex native cells that cannot match a single text span keep their ordinary
renderer; cross-block native dragging is not supported. Android is deferred.

Coverage lives in `document-comment-selection.test.js`, the document-manager
status/draft race tests, and the read/edit selection scenarios in
`tests/e2e/docs-rich-editor.spec.cjs`. Native `DocumentAnchorTests` covers
Markdown table coordinates and resolve/reopen transport retention;
`DocumentInlineUITests` covers native touch/composer and relaunch flows.
Synthetic tests do not establish real-account cross-device or installed-device
acceptance.
