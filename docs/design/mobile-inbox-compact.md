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
