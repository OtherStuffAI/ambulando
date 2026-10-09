# Compact mobile Inbox

Inbox items keep context and relative time on their first line, title on their second, and activity reason or chat preview/message count on their third. Identical chat titles and previews are shown once. Long context labels ellipsize; their complete text remains in the DOM and title attribute. Source records, read state, and routing are unchanged.

Below 768px, cards use smaller icons, tighter spacing, and no separate Open pill. Existing whole-card click, Enter, and Space navigation remains available. Unread highlighting and separate read/done buttons remain; mobile action buttons have 44px minimum targets and visible labels. Desktop retains Open labels.

## Verification

Run `node scripts/verify-inbox-compact-browser.mjs`. This renders the actual source Inbox template and styles in Chromium using intercepted requests only, with no server or backend access. Synthetic task, attachment, duplicate/distinct chat preview, review task, and document rows cover 375, 390, 430, and 1440px widths. It checks overflow, card height, action targets, keyboard activation, read highlight clearing, and callback dispatch. Callback destinations are instrumented; this is not a live backend navigation test. Existing Inbox history and bulk-read unit tests cover the production behavior.

The initial comparison measured mobile cards at 76px versus 113–161px before, and desktop cards at approximately 78px. Local screenshots and JSON measurements are emitted under `/tmp/flightdeck-inbox-*`.

The full suite at implementation time passed 3666/3668 tests; failures were an unrelated chat file picker attribute-order assertion and a 10-second materialization responsiveness timeout. The responsiveness test passed in isolation. Focused Inbox history, bulk-read, and release-note tests passed (48 tests). Build 1911 and asset verification passed. The public-source check reports pre-existing private handoff documents. A live iPhone/Safari smoke check remains: WebKit was not installed in the available browser cache.

## Toolbar

Independent chat, task, document and file visibility buttons replace the old
single-selection dropdown; see [Inbox visibility](inbox-type-visibility.md).
Desktop keeps the controls inline. Below 768px, Inbox title, four independent
filters, Search, create and menu share one default horizontal row. Controls use
30px widths, 44px heights and 4px gaps to fit even a 320px viewport without
clipping or scrolling. Accessible labels and visible keyboard focus remain.
Focus opens Search and its submit button on a full-width second row, keeping
filters above. Blur collapses Search while retaining its query; the border
indicates a retained draft. Enter submits; expanded Search exposes native clear. The heading stays sticky and the read menu remains unclipped.

The offline browser script renders the production heading and cards at 320,
375, 390, 430 and 1440px. It checks control bounds, keyboard toggles, all hidden,
search callbacks, new-thread dispatch, menu keyboard opening/Escape/actions,
menu hit testing and sticky scrolling. Read/done and whole-card actions use
instrumented local callbacks; backend navigation is outside this probe.

To check the template and CSS that an existing runtime actually serves, run
`FLIGHTDECK_INBOX_SERVED_URL=http://127.0.0.1:<registered-port>/ node scripts/verify-inbox-compact-browser.mjs`.
The probe downloads the served HTML and every linked stylesheet without recompiling
source CSS, then runs the same fixture behavior checks and mobile/desktop screenshots.
It uses synthetic records and does not authenticate or contact Tower. This proves
served layout behavior, but does not establish the build loaded in an existing user
tab. Check runtime asset hashes and service-worker state separately.

## Ambulando phone layout

Ambulando's `src/sol.css` overrides the legacy one-row toolbar at widths up to
768px. Inbox title/create/menu share a row, and four 44px filters plus Search
share the next. Focus expands Search into its own row. This retains independent
filters, native input behavior, keyboard focus and unclipped menus without
reducing touch targets to fit a single row. Titles allow two lines, preserving
more useful preview text; shorter cards retain the 76px minimum.

The phone app header is 60px, with a 44px profile control, and the scope/channel
rows use tighter surrounding spacing. Sol's hidden bottom section switcher has
no reserved content height. Recovery notices stay in normal flow, with an 8px
bottom margin; Deck no longer adds 24px above Inbox or an invisible Hello-card
gap. Recovery visibility and authentication/sync behavior are unchanged.

Deck pager buttons are 44px square transparent hit areas with 8px dots (10px
for the active card), rather than painting a tiny-width button whose global
minimum height makes a tall bar. Desktop and tablet rules above 768px retain
the established geometry.

`x-sol-viewport` tracks the visual viewport on the app shell. Phone content and
thread overlays use its height/offset when the keyboard reduces or pans the
viewport. Updates are frame-coalesced and skipped while pinch zoom is active,
retaining native zoom/panning. Safe-area padding remains on composers/content.

`tests/e2e/mobile-layout.spec.cjs` exercises seeded Inbox, recovery, phone drawer
navigation, pager, composer drafts at full/short heights, task detail, a loaded
document editor, and Files with a PDF at 320/375/390/430/900/1440px in both themes.
It blocks service workers and external requests so cached runtime assets cannot
replace fixture chunks. Use the configured managed runtime as
`PLAYWRIGHT_BASE_URL`; no standalone preview is necessary. Optional
`SOL_EVIDENCE_DIR` must be ignored and untracked. Screenshots/measurements are
synthetic local evidence, not authenticated backend delivery or physical-device
keyboard validation. `tests/sol-viewport.test.js` covers keyboard resize/pan,
coalescing, pinch zoom and listener cleanup. Physical iPhone/WebKit and existing
authenticated tabs still need a smoke check.
