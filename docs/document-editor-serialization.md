# Rich document serialization

The rich editor saves ProseMirror JSON alongside compatibility Markdown and
content blocks. `validateDocumentContentModelRoundTrip` reparses that Markdown
and checks text, inline marks, links, images and hard breaks before a PG save
uploads content or changes Tower. Document length is not an integrity criterion.

`prosemirror-to-flightdeck.js` must preserve rich input rather than ask the
validator to excuse losses:

- Encode whitespace at prose/mark boundaries as decimal character references,
  including nonbreaking spaces from paste. Encode inline tabs and soft newlines
  as references so Markdown cannot interpret them as block syntax. Code stays
  literal, and explicit hard breaks keep their Markdown representation.
- Emit explicit hard breaks as attribute-free `<br>` tags so leading,
  trailing, consecutive and break-only paragraphs survive compatibility reopen.
  Preserve underline with `<u>` tags, including pasted underlined links. The
  importer and preview recognize these limited inline tags; other HTML stays
  literal/escaped. Preserve spaces beside breaks as references.
- Use a consistent inline wrapper order and keep shared outer marks open
  across adjacent text runs. A bold/italic-to-italic transition must not emit
  colliding delimiters that reopen as literal underscores.
- Serialize every list-item child in order. Continuation paragraphs, nested
  lists, headings and quotes must not be omitted or moved. Indent continuation
  lines to the content column after the actual list marker; ordered markers can
  have multiple digits, while task checkboxes belong to the item content.
  When nested blocks follow an empty parent item, the parser restores an empty
  paragraph rather than duplicating those blocks' raw Markdown as parent text.
- Keep the original editor state intact. The parser decodes references after
  lexing prose; escaped literal entity text must not be decoded recursively.

Regression coverage uses a generic short timeline in
`tests/fixtures/short-rich-document.js`. Adapter tests force Markdown-only
reopen, a native Tiptap/jsdom test compares rich structure and rendered marks,
and document-manager tests exercise manual save and autosave. Truncated models
still retain the draft and prevent upload/Tower writes. These tests do not
replace an authenticated browser save/reload check against a local Tower.

## Draft recovery lifecycle

Document edits are stored in the workspace Dexie database under the exact
workspace and document ids. Input schedules a short local checkpoint, and an
explicit Save performs another awaited checkpoint before serialization,
storage upload, signing, or transport begins. A rejected or thrown save leaves
the editor and lease open, records the failure on the draft, and checkpoints
the visible state again. Navigation also checkpoints dirty state. The draft is
deleted only after Tower has acknowledged the canonical content (or the user
explicitly discards a recovery), so ordinary success does not retain sensitive
draft content indefinitely.

Document creation uses the uploaded storage object as its retry identity. The
client checks the destination channel before POST and reconciles again after an
ambiguous timeout, network failure, or server error. If Tower already accepted
that storage object, Flight Deck adopts the existing document instead of
issuing a duplicate create.

## Mobile editor viewport

Mobile Docs uses a native vertical scroller around the editor, including title,
recovery disclosure, long rich/source content and the notebook footer. The toolbar
stays sticky. Avoid clipping an unbounded document body inside a flex container;
each bounded flex ancestor needs `min-height: 0`. Keep bottom navigation and the
Docs/Comments switcher outside the usable scrolling viewport.

Recovery details and actions use a disclosure with a visible draft summary.
Expanding it only changes presentation; it must never promote, discard or clear
a draft. Existing dirty-state and in-flight action guards still control buttons.
The Docs shell follows visual viewport resize events while mounted and removes
its listener when unmounted. Viewport emulation is useful regression coverage,
but physical-device keyboard testing remains necessary for device-specific behavior.

Changing Tiptap editability must suppress its optional update emission. Lease or
recovery access changes do not modify document content; emitting an update would
mark the restored authoritative body dirty again after a discard. Real content
transactions continue to update and checkpoint drafts normally.
