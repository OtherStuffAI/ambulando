# Scope chat loading

Scope home selects the combined conversation window before reading reply tails.
The per-channel compound-index candidate reads remain bounded. This changes the
amount of discarded work, not the stored history or its ordering.

## Read and subscription ownership

`getMessagePresentationCandidates` reads the indexed root prefix, exact source
messages for summaries, pending/failed sends, focused parents and effective
membership. Per-channel parent normalization and lookahead semantics remain the
same. `getMessagePresentationWindowByChannels` merges those candidates using the
existing thread-aware selector, then hydrates reply tails for surviving roots
and the active/focused thread. The default tail remains 81 values; there is no
six-reply substitution. Both phases retain the captured workspace database.

Scope selection restores the existing nine-entry presentation cache immediately.
Its live query supplies the cold initial read and clears the pending state,
including an empty scope. Read errors clear pending state and expose a scope-only
retry instruction. Selecting the scope again creates a new subscription.

The reaction subscription reads only reactions for IDs from the applied
presentation. Its key changes when those IDs change. Reaction updates do not
repeat the message reader or gate first message application. Workspace,
selection, active/focused thread, channel-set and navigation-authority guards
reject stale callbacks. A new authority projection rebinds scope subscriptions
even if the channel IDs are unchanged. Existing cache clearing on workspace or
access changes remains in its owning paths.

`scopeChatLoadTiming.contentPaintMs` records the first content/empty-result paint
boundary after application, or the cached presentation paint boundary. Trace
entries also record query duration, channel count and returned message count.
These are browser paint opportunities, not proof that every pixel is visible.
Scope home has no enabled composer until the user selects a channel; its trace
therefore does not claim composer readiness.

Canvas Chat naplets have a distinct reduced-startup iframe/channel-thread path.
This change does not alter their iframe lifecycle.

## Reproducible database measurement

Run against an existing configured local runtime; this command starts no server:

```bash
PLAYWRIGHT_BASE_URL=http://127.0.0.1:41031 \
PLAYWRIGHT_BROWSER_CHANNEL=chrome PLAYWRIGHT_DISABLE_VIDEO=1 \
bunx playwright test tests/e2e/scope-chat-loading.spec.cjs
```

Replace the example port with the registered local runtime's port. The isolated
page bundles one source database module instance, intercepts requests, and boots
neither Alpine nor a backend connection. It compares the former per-channel
hydration/merge algorithm with the two-phase reader on the same persisted rows.
Each channel has 24 source/summary pairs, 90 replies per conversation, failed and
pending sends, a deleted root and an archived root. Five alternating samples
check identical final IDs. A liveQuery test verifies arrival beyond the current
indexed boundary; concurrent reads verify their independent channel sets.

IndexedDB instrumentation counts value rows delivered to JavaScript and request
objects, not storage-engine B-tree visits. Cursor continuation values can exceed
the number of request objects. The unit fixture separately checks full row
parity, focused/inherited membership, keyset bounds, ties and optimistic sends.

Measured 2026-10-23 on the local macOS arm64 development machine, headless Chrome:

| Channels | Persisted rows | Values read before → after | Read requests before → after | Reader p50 before → after | Reader p95 before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 2,212 | 927 → 927 | 25 → 25 | 5.4 → 5.6 ms | 10.5 → 6.7 ms |
| 10 | 22,120 | 9,270 → 2,061 | 250 → 161 | 62.5 → 15.2 ms | 70.7 → 18.7 ms |
| 30 | 66,360 | 27,810 → 2,781 | 750 → 441 | 275.6 → 22.4 ms | 312.8 → 26.6 ms |

These small samples establish reader work reduction on this fixture. They do
not establish end-to-end latency, cold disk behavior or population percentiles.
The one-channel path does the same database work; removal of repeated initial
reads is a separate subscription change.

## Renderer validation and limits

Run the established production-asset typing/navigation baseline separately:

```bash
PLAYWRIGHT_BASE_URL=http://127.0.0.1:41031 \
PLAYWRIGHT_BROWSER_CHANNEL=chrome FLIGHTDECK_PERF_DIST=1 \
PLAYWRIGHT_DISABLE_VIDEO=1 bun run test:e2e:perf
```

That baseline seeds Alpine after shell startup and cannot measure this database
optimization by itself. See `docs/playwright-performance-baseline.md` for its
historical comparison. Integrated scope-renderer experiments exercised cached
revisits and rapid switching, but their final live-arrival checks were not
reliable; they are retained only as ignored operational evidence. They are not
acceptance evidence for a sub-100-ms revisit or sub-500-ms first useful paint.

An authenticated human-workspace smoke remains necessary for end-to-end scope
loading, access revocation, drafts, scroll and incoming conversations. Unit tests
cover generation rejection, workspace fences, authority rebind, empty scopes,
read failures and reaction-target updates. No authenticated backend or physical
device result is implied by these synthetic fixtures.

Build 2611's production-asset baseline passed all seven scenarios. All three
74-character typing samples rendered exactly, with zero typing long tasks over
50 ms. Observed values:

| Scenario | Shell / composer ready | Key-to-input p95 | Key-to-render p95 | Max frame gap |
| --- | ---: | ---: | ---: | ---: |
| Regular (200 tasks/docs, 120 replies) | 286 / 423 ms | 0.4 ms | 109.5 ms | 83.3 ms |
| Heavy (2,000 tasks/docs, 800 replies) | 285 / 759 ms | 0.4 ms | 123.8 ms | 83.3 ms |
| Diagnostics enabled | 282 / 443 ms | 0.7 ms | 119.1 ms | 100.0 ms |

Seeded navigation had shell/composer readiness 307/840 ms, thread-open p95
183.9 ms and task-detail-open p95 267.4 ms. The immediate pre-change run measured
116.5/323.3 ms for those two navigation operations; the historical documented
baseline measured 145.8/499.8 ms. Thread opening was slower in this small final
sample, while task detail was faster. Both remain below the documented proposed
250/750-ms guidelines; the samples do not establish causality or production
percentiles. The seeded baseline disables workspace subscriptions and therefore
does not directly exercise the scope-reader change.
