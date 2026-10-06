# Local wiki page navigation

Existing channel wiki links and cached Home pages open from the local document
collection. Navigation waits for an outgoing dirty draft to reach IndexedDB;
it does not wait for Tower saves, edit leases, document hydration or comments.
New-page creation remains a separate operation with its existing creation
feedback and canonical write checks.

`followDocWikiLink` records only the latest visit in `wikiNavigationTiming`:
link activation, local draft checkpoint, local selection and editor mount.
These bounded stage timings help distinguish local work from rendered latency.
They are diagnostics, not proof of paint; browser measurements separately sample
visible editor content on animation frames after a native click or touch tap.

`openDoc` loads local editor state first. After Alpine updates and a paint,
background reconciliation starts. An available body refresh updates the mounted
editor in place, preserving selection, instead of destroying and remounting it.
The response must belong to the current document, open generation and workspace.
It also waits for local draft restoration and cannot replace dirty, acquiring,
editing, recovery or saving state, or text changed since opening. Hydration retry
and failure handling use the same visit guard. Existing canonical save ACLs and
lease acquisition remain authoritative. Outgoing lease release waits for that
record's pending saves without delaying the new page.

Cached Home skips the collection refresh. Missing Home retains the guarded local
refresh and document-list fallback. The existing-link path passes its completed
local checkpoint to `openDoc`, avoiding a duplicate outgoing draft serialization.

## Validation on build 2225

The native wiki suite uses an isolated synthetic workspace in the served app,
real IndexedDB draft persistence/restoration, and transport probes held open or
aborted. It exercises desktop clicks, native touch taps, backlinks, Home, browser
Back and rapid switches. Each click-to-content measurement is checked below
200 ms. No authenticated user records are changed by this test.

Final complete-suite samples (milliseconds):

| Device | Transport | Existing link | Backlink | Home |
| --- | --- | ---: | ---: | ---: |
| Desktop | Hanging | 91.7 | 123.4 | 83.6 |
| Desktop | Unavailable | 82.8 | 102.6 | 89.4 |
| Touch | Hanging | 15.3 | 118.7 | 135.7 |
| Touch | Unavailable | 131.9 | 18.0 | 9.1 |

The earlier isolated build 2224 baseline, with hydration and writes stubbed,
measured 14.1 ms desktop and 5.6 ms touch. It did not reproduce the reported
several-second authenticated delay. These samples establish that pending remote
operations cannot gate cached rendering in the corrected path; they do not
establish the exact cause or latency of a particular live user session.

All 19 wiki browser checks and 4,515 unit tests passed (one unit test skipped).
Focused checks cover late A/B/A and workspace responses, refresh without remount,
draft restoration ordering, durable outgoing drafts and pending-save lease release,
as well as the existing canonical access and save checks.

Final performance baseline (six checks, without concurrent validation load):

| Scenario | Shell / composer readiness | Input p95 | Render p95 | Typing long tasks |
| --- | --- | ---: | ---: | ---: |
| Chat, 200 tasks/docs | 203 / 340 ms | 0.5 ms | 148.9 ms | 0 |
| Heavy chat, 2,000 tasks/docs | 203 / 737 ms | 0.4 ms | 193.5 ms | 0 |
| Seeded navigation | 221 / 738 ms | n/a | n/a | n/a |

Both typing scenarios retained all 74 characters. Thread-open p95 was 157.8 ms;
task-detail-open p95 was 255.1 ms, with 14,539 DOM nodes. Heavy typing maximum
frame gap was 116.7 ms. These results are comparable to or faster than
`docs/playwright-performance-baseline.md` (thread 145.8 ms, task 499.8 ms) and
the preceding build's recorded local run (thread 157.1 ms, task 344.7 ms).
The first run under concurrent full/native checks had task-open p95 859.1 ms;
the final run above removes that measurement contention and is the handoff baseline.

Run against the configured managed Flight Deck URL, leaving Tower at its default
local target:

```bash
PLAYWRIGHT_BASE_URL=http://127.0.0.1:41045 PLAYWRIGHT_DISABLE_VIDEO=1 bunx playwright test tests/e2e/wiki-pages.spec.cjs
PLAYWRIGHT_BASE_URL=http://127.0.0.1:41045 PLAYWRIGHT_DISABLE_VIDEO=1 bun run test:e2e:perf
```

Authenticated live latency, cross-user ACL revocation and physical mobile-device
behavior remain manual checks. Static unused-code reporting still identifies
existing duplicate exports and unused exports; overlapping shell orchestration
in `app.js` and `shell-state.js` remains outside this change. Runtime coverage
is needed before any separate removal; static findings alone do not prove deadness.

## First-click activation and notebook controls

Wiki links own ordinary primary mouse activation. Their node views stop
ProseMirror's primary mouse-down handler from selecting/refocusing the atom
before click, and retain the existing label text node when its text is unchanged.
Shift-click extends text selection from the existing editor anchor without
focusing the link atom. Keyboard movement and native drag selection remain
available; Shift-click and pointer drags do not navigate. Touch taps still use click
activation. Renames continue updating labels without changing stored IDs.

A WebKit browser negative control restored the original unconditional label
refresh and default node-view mouse handling in the served JavaScript response,
without changing source or user records. The first native click stayed on Home;
the second opened the linked page. WebKit also replaced label text nodes during
native editor transactions, while Chromium retained them. This explains why
Chromium-only first-click coverage did not expose the laptop defect.

The extra notebook row is removed. The selected document's existing actions
menu contains All docs, Set as home and Clear home; Current home page is disabled.
Channel pages hide the duplicate All documents breadcrumb. Home and the
collapsed-by-default Backlinks control share the bottom footer. Home shows the
active page and retains existing missing-home fallback. Home management is not
added to document-list row menus. Mobile All docs creation/options controls are
restored after the existing desktop CSS defaults, including for empty channels.

Transport-probe browser tests block service workers so Playwright intercepts
probe requests consistently in Chromium and WebKit. Other wiki tests use the
ordinary served app. Expected integrity text is trimmed like the production
integrity guard, retaining interior paragraph separators in both engines.

### Validation on build 2230

All 4,515 unit tests passed (one skipped), along with 25 Chromium and 25 WebKit
wiki checks and six performance checks. Native checks cover first click in
unfocused/focused editors, repeated clicks/taps, keyboard activation, drag and
Shift selection, Home/menu/footer actions, creation feedback and durable drafts.
Lint, public-source, release-note, build, dist asset and diff checks passed.

Click-to-visible-content timings in milliseconds, with real IndexedDB drafts
and intercepted transport probes in isolated synthetic workspaces:

| Engine | Device | Transport | Link | Backlink | Home |
| --- | --- | --- | ---: | ---: | ---: |
| Chromium | Desktop | hanging | 112.6 | 122.7 | 129.3 |
| Chromium | Desktop | unavailable | 99.1 | 94.5 | 127.9 |
| Chromium | Touch | hanging | 97.9 | 59.5 | 8.7 |
| Chromium | Touch | unavailable | 136.2 | 107.8 | 126.5 |
| Webkit | Desktop | hanging | 24.0 | 17.0 | 14.0 |
| Webkit | Desktop | unavailable | 20.0 | 18.0 | 16.0 |
| Webkit | Touch | hanging | 25.0 | 26.0 | 20.0 |
| Webkit | Touch | unavailable | 30.0 | 26.0 | 21.0 |

Final isolated performance confirmation:

| Scenario | Shell / composer readiness | Input p95 | Render p95 | Typing long tasks |
| --- | --- | ---: | ---: | ---: |
| Chat, 200 tasks/docs | 246 / 502 ms | 0.9 ms | 144.0 ms | 0 |
| Heavy chat, 2,000 tasks/docs | 203 / 730 ms | 0.6 ms | 167.3 ms | 0 |
| Seeded navigation | 229 / 754 ms | n/a | n/a | n/a |

Both typing scenarios retained all 74 characters. Thread-open p95 was 167.1 ms;
task-detail-open p95 was 324.8 ms, with 14,539 DOM nodes. These remain within
the documented gates and comparable to the recent wiki baseline. Against the
original performance baseline, typing and task detail are faster, while thread
open is 167.1 versus 145.8 ms. The first isolated run measured render p95
202.5 / 142.3 ms and thread/task p95 220.1 / 313.6 ms; a confirmation run
bounded that variation without changing source. Both runs passed all six checks,
retained 74/74 characters and reported zero typing long tasks.

The configured managed server's HTML, version metadata, main script, CSS and
editor module were compared byte-for-byte with local dist output. No managed
service was restarted or remotely deployed. Physical-device behavior and
cross-user authenticated Home/ACL propagation remain manual checks. Knip still
reports 76 unused exports, four duplicate exports and one unresolved canonical
test import; no unrelated code was removed.
