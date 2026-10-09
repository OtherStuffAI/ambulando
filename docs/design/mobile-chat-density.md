# Phone conversation space

Phone conversation history owns the remaining height between a bounded header
and a bounded footer. Ambulando keeps its colors and native zoom. Reading text
uses 14px with 1.45 line height on phones; the editable draft and title input
remain 16px to avoid Safari input-focus zoom. Desktop and tablet rules remain
outside the phone overrides.

The title shows at most two lines within a 44px rename target. Five header
actions fit in a second 44px row, with smaller icons inside their hit areas.
Title editing, sequence navigation, thread menu, resize and close retain their
existing handlers. A bounded header scrolls if title-edit errors need more room;
the menu floats outside that scroll box.

The footer groups the composer, editing state, recent mentions and attachment
previews. It may use at most 30% of the visual viewport (180px maximum). Ancillary
state scrolls in that footer rather than displacing history. The draft itself
has an independent scroll box, capped at 22% of visual height (112px maximum).
Menu and Reply share a horizontal row beside it. Safe-area padding remains.
The editor DOM, selection, IME handlers, draft model and send guards are retained.
A phone-only footer directive keeps the focused editor fully visible when chips,
edit status or keyboard resizing change its position. It scrolls only that footer,
without moving history or replacing editor content. Manual footer scrolling stays
available, and the adjustment skips native pinch zoom.
Phone autosizing respects the CSS cap, refreshes cached metrics after a visual
viewport height change, and preserves editor scroll position. Desktop manual
resizing continues to work.

`x-sol-viewport` supplies visual height and offsetTop; the dialog follows keyboard
panning as well as resizing. During pinch zoom it retains the last unzoomed
layout and leaves panning to the browser. This does not disable zoom or change
host WmApp chrome. Root rem sizing remains 16px; typography changes are scoped to phone conversation and Inbox surfaces.

## Verification

Use the configured Ambulando runtime, with external backend requests blocked:

```bash
PLAYWRIGHT_BASE_URL=http://127.0.0.1:41031 PLAYWRIGHT_DISABLE_VIDEO=1 \
  bunx playwright test tests/e2e/mobile-chat-density.spec.cjs --workers=1
```

The fixture uses the production store and template, a long title, 25 messages
and a 191-character prose draft. It covers 320/375/390/430px in both themes,
400/360/320px visual heights, nonzero offsetTop, reduced layout height, zoom,
internal history/editor/footer scrolling, draft retention, typing/IME,
attachments/edit errors, mentions and chat actions. At 320px visual height,
normal history must retain at least 110px, with at least 100px under additional
footer state. Desktop/tablet have separate long-draft checks. Existing composer
unit coverage also checks height caching, selection, send guards and failures.

Optional `SOL_EVIDENCE_DIR` must be ignored and untracked. Screenshots, geometry,
run logs and reference source snapshots belong in ignored handoff storage.

For a classic comparison, verify that `7ec1e18` is the parent of `1004c01` in the
local retired Flight Deck repository, then read its `index.html` and
`src/styles.css` using `git show` into ignored private storage. Do not change its
checkout. `SOL_DENSITY_COMPARISON=classic` and `SOL_CLASSIC_DIR=<snapshot>` render
the actual archived thread template and stylesheet; the shared current compiled
store supplies identical records and draft behavior. This isolates presentation,
and is not a claim that the entire historical application was rebuilt. The
classic viewport is reduced to the same visible dimensions because its styles
predate Sol's visual-viewport tracking. `SOL_DENSITY_COMPARISON=before` with
`FLIGHTDECK_TEST_DIST=<saved-dist>` measures the prior Ambulando build.

Synthetic desktop Chromium and mocked VisualViewport checks do not establish
physical iPhone Safari/WmApp keyboard, IME or pinch-zoom behavior, nor authenticated
Tower delivery. Those remain device smoke checks. Fresh served asset hashes also
do not show that an existing authenticated tab has refreshed.

## Inbox proportions

Phone app/scope/channel rows use 56/45/45px respectively. At 375–430px the
Inbox toolbar fits one row, retaining a visible search icon and expanding the
16px search field onto its own row when focused. At 320px two rows preserve
44px targets. Two-line card titles use 13px/17px and previews use 12px/15px.
Read and done actions paint different 24px circle/square check icons within
44px buttons, with their existing labels and handlers. Review-task actions
stay beside the title, keeping representative cards around 81px.

`tests/e2e/mobile-inbox-density.spec.cjs` covers both themes, phone widths and
desktop/tablet, card scrolling, preview retention, search expansion and action
callbacks. Its optional classic comparison replaces the Inbox template with
the archived template and stylesheet while retaining the shared record fixture.
