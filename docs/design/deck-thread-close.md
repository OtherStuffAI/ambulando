# Deck thread close navigation

Deck conversations can open from a card or from a direct browser route. A
`deckThreadModal` history flag identifies the displayed surface; it does not
prove that browser Back will return to a Deck page. Route hydration can replace
the initial entry, and older tabs can retain the flag without a return entry.

When routing pushes a Deck conversation from a URL without `threadid`, it
records `deckThreadModalOrigin`. Sequential thread navigation replaces the
modal entry and preserves that origin. Replacing a direct route does not invent
an origin, and pushing from another thread does not inherit one: its immediate
predecessor would still be a thread.

Close uses Back only for an entry with an owned origin. Otherwise it closes
the thread locally, restores the Deck context and replaces the current URL.
The shared thread close path retains drafts and persisted messages; submitting
message edits continue to prevent closing. Desktop and phone use the same
navigation rule, including the header X and backdrop.

`tests/e2e/mobile-thread-close.spec.cjs` exercises production templates and
history with synthetic conversations. Use the managed Sol runtime and installed
browser; do not start a separate preview server. Backend requests remain blocked
in the synthetic fixture. This coverage does not establish authenticated Tower
delivery or physical iPhone WebKit behavior.

New-thread dismissal also retains an in-memory draft in `chatComposerDrafts`,
keyed by workspace, channel scope, channel and `__new_thread__`. The new-thread
key takes precedence over an existing reply selection. Close, backdrop, Escape
and returning to channel routing save the live editor value and mentions plus
the title, manual-title flag, request ID, file preparations and audio drafts.
Dismissal detaches attachments without revoking their draft-owned preview URLs.
Upload callbacks update the saved owning attachment even when another composer
is visible. Channel preparation completes before the new draft is restored, so
navigation saves cannot overwrite it with an empty editor. Workspace activation
saves and detaches an open draft before changing identity or channel metadata;
an in-progress send must finish before switching. Failed sends retain
the same draft and request ID; accepted sends clear it through the existing
composer success lifecycle. These drafts do not survive a page reload and add
no Tower records or contracts.

`tests/e2e/new-thread-drafts.spec.cjs` covers real modal Escape/backdrop dismissal,
mention rehydration, prepared files, destination switching and simulated failed
and accepted sends at phone and desktop widths. Upload-stage behavior is covered
separately in `tests/chat-upload-routing.test.js`; synthetic browser sends do not
attest authenticated Tower delivery.
