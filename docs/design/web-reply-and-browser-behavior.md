# Web reply focus and browser behavior

Unused space in the thread composer forwards a click or tap to the existing
editable reply field. The `sol-composer-focus` directive preserves the draft and
leaves editable text selection, links, attachment inputs, labels, menu items and
buttons to their own handlers. A disabled or busy composer is never focused by
this forwarding path. The same behavior applies to the workroom reply bar.
Keyboard navigation continues to use the real contenteditable and action buttons.

Personal pin ordering uses the existing typed relative-move contract described
in `pinned-threads.md`. Pointer release calculates the final insertion position
synchronously: a quick drag must not save a stale animation-frame preview.
The frame loop remains responsible for the preview and edge scrolling. Production
store interaction coverage lives in `tests/e2e/personal-pins.spec.cjs`; composer
pointer, Chromium touch, keyboard, draft and action coverage lives in
`tests/e2e/batch-composer.spec.cjs`.

## Browser ownership

The web app runs inside the user's browser and has no general embedded browser
or native WebView delegate. Its header has command search through the brand,
Notifications, then Avatar; resource pin controls belong to the resource context.
The native Browser control and the native five-control toolbar are owned by the
native apps. Adding a new web browser is not required to match those controls.

Nostr Browser's canonical repository is `humansinstitute/nostr-browser`.
Its browser implementation configures native upload pickers, download delegates,
new-window handling and origin-scoped native API bridges. Those platform
interceptors are not transferable to a normal web page. In the web app:

| Flow | Owner and existing implementation |
| --- | --- |
| Upload/file picker | Host browser file input; selected files enter the existing attachment upload flow. Cancellation leaves the draft intact. |
| Signed file download | `files-manager.js` retrieves authorized bytes, creates a Blob URL, sets the download name, then revokes the URL. Errors remain visible. |
| Text export | `text-attachment-viewer.js` creates a text Blob and uses the browser download flow. |
| Blob/data URLs | Host browser origin and download rules apply. No native bridge or origin bypass is injected. |
| New windows | Host browser popup rules apply. Private dashboard and Canvas sandboxes retain their own narrower policies. |
| Signing, clipboard, media and other web APIs | Existing browser permissions and origin checks apply; this change grants no additional capability. |

Browser tests for signed image/PDF preview, download and denied-storage behavior
live in `tests/e2e/deck-file-preview.spec.cjs`. Their HTTP responses are simulated
and signatures are verified; they do not certify an authenticated production
upload/download or physical-device save dialog. Native parity evidence belongs
to each native implementation and cannot be inferred from these web tests.
