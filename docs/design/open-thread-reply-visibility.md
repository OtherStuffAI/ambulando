# Open-thread reply visibility

The Inbox conversation modal can be keyed by a thread record while canonical
message rows use the source-message ID as their parent. A send acknowledgement
could patch that canonical row over the modal projection after its live query
had already emitted. The reply then disappeared from the derived thread list.
The generic record equality check ignored parent-only changes, so another
identical-version projection could not repair it. Reopening rebuilt the window.

A separate race retained pending messages against the selected Chat channel,
even when Inbox was showing a different channel. A delayed initial detail query
could therefore remove the pending reply before acknowledgement.

The chat manager now uses the displayed Inbox channel for pending retention,
projects local patches under the open thread without rewriting canonical Dexie
rows, and compares thread membership and reconciliation fields when applying
message projections. Local refreshes reject results overtaken by a newer
collection revision or navigation. A send captures its destination before
persistence; completion updates that view only while it is still current.
Completion reads/writes run in a message transaction against the captured
workspace database key through a separate connection. Switching workspaces
closes the active connection, so retaining that object alone is insufficient.
The scoped transaction reconciles or fails the original row without changing
the newly selected database, including when record IDs happen to match.
Dexie remains the persisted source, and existing live queries own detail loading.
No shared payload or backend contract changes are needed for this fix.

Regression tests exercise the real send methods and Dexie persistence with a
controlled acknowledgement: stale detail result, acknowledgement before/after
server echo, canonical parent normalization, duplicate reconciliation, navigation
while awaiting acceptance, workspace switches before acceptance or rejection,
delayed local refresh, and parent-only projection
correction. Existing Inbox tests cover live subscriptions and bounded reads.

An authenticated browser smoke pass remains necessary in Chat and Inbox:
send in an already-open conversation, observe pending/accepted exactly once,
allow SSE echo and refresh, and switch conversations during a delayed send.
Verify draft isolation and scroll position in desktop and mobile layouts.
Source and build validation does not establish installed-client activation.

## Titles, local content and history refresh

Thread rows in `chat_messages` carry title and transcript membership metadata.
They are retained for headers and branch authority, but never counted as authored
messages or rendered as message bubbles. Overview roots prefer the real source
for ordinary threads and the thread identity for branches. Detail projections
retain title metadata alongside bounded latest content, deduplicate by record ID
and exclude a separately rendered real parent from the effective reply list.
Identical message bodies remain distinct records.

Inbox opening keeps only matching selected-thread content, then the dedicated
Dexie live query reads the latest rows. Own replies can display even with a
partially cached root; inherited rows still require effective membership.
Profile enrichment is deferred until after local publication. Initial loading
appears only without local content; remote refresh has a separate status.
Selection/workspace generations continue to guard publication and pagination.

Persisted history coverage restores continuation on reopening. Automatic
first-page reads can reuse coverage for 30 seconds while thread lineage,
version, activity version and workspace authority match. Explicit history
expansion remains force-loaded. Authority changes, expired coverage and thread
updates trigger revalidation without gating the local content projection.

## Validation checkpoint

- `bun run test tests/chat-message-manager.test.js tests/inbox-thread-history.test.js tests/chat-presentation-cache.test.js tests/section-live-queries.test.js`: 226 passed, including both real workspace-switch completion cases.
- Final `bun run test`: 3,657 passed, two failed across 266 files. The 20,000-row materialization responsiveness test exceeded its 10-second timeout; isolated retry also timed out. Inbox history's edit-observation wait failed under the full run; an immediate isolated `bun run test tests/inbox-thread-history.test.js` passed all 11 tests. Earlier full runs had only the materialization timeout (including `bun run test --maxWorkers=2`). No assertions or timing limits were relaxed.
- `bun run test tests/release-notes.test.js tests/dist-release.test.js`: 11 passed.
- `bun run build`: passed, build 1907. Existing warnings: source schema checkout absent (bundled schemas used), and large chunks.
- `bun run verify:dist` and `git diff --check`: passed.
- `bun run check:public-source`: failed on existing preserved tracked handoff/operator/private markers; no cleanup or policy bypass performed.
- `FLIGHTDECK_VERIFY_BUILT_WORKER=1 node scripts/verify-inbox-thread-browser.mjs`: could not launch because the required Playwright WebKit executable was absent. No authenticated browser, remote deployment, OTA publication, or runtime restart was performed.

The checkpoint includes compatible concurrent activity-recovery source, tests,
and supplied handoff documents as requested. Activity contract/runtime activation
is covered by its separate design/handoff. The reply fix changes local browser
persistence and presentation only.
