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
