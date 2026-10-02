# Independent Inbox record type visibility

The Inbox toolbar exposes chat, task, document and file buttons alongside Search on desktop.
Blue means shown; white means hidden. Each native button independently changes
its family and exposes a stable accessible name and `aria-pressed`. Enter and
Space use native button activation. Every combination, including all hidden,
is valid. All hidden displays an explicit status message.

The selection remains session-only, matching the previous dropdown: there was
no persisted type preference to migrate. New sessions show all four families.
A legacy in-memory single selection is normalized to that one visible family
before its first toggle. Switching context retains type visibility, while the
existing context/search and pagination reset rules remain in effect.

Filtering intersects submitted search. A toggle immediately updates the local
card projection and resets bounded source pagination, with query revisions
protecting against stale results. Source recovery applies the same visible
family set, and hidden source families cannot advertise additional pages.
Visibility does not mark cards read or change record state or card actions.

Desktop keeps the controls inline. Below 768px, title and adjacent create/menu
buttons occupy the first row. Independent filters share the second row with a
44px Search icon. Focus opens a full-width Search field and submit button,
with filters accessible below. Blur collapses Search while retaining its query;
the border indicates a retained draft. Enter submits, and focusing Search also
exposes its submit button and native clear control. Mobile buttons retain 44px
touch targets. The heading stays sticky and the read menu remains unclipped.

Validation covers all 16 combinations, search intersections and legacy
in-memory normalization in unit tests. `scripts/verify-inbox-compact-browser.mjs`
uses the production template, styles and toggle methods with synthetic records
at 320, 375, 390, 430 and 1440px. It probes independent hiding, all hidden,
keyboard activation, pressed state, bounds, sticky scrolling, read/done and
card actions. This offline browser probe verifies frontend callbacks; live
backend navigation and physical iPhone/Safari remain separate smoke checks.
