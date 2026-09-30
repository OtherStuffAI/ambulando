# Incremental cache and bounded views

## Ownership and rollout

TowerSyncService remains the network owner. Its existing materialisation worker
commits Dexie changes, and liveQuery supplies Alpine. Views do not fetch records
directly. No React/native or workspace-storage redesign is involved.

The producer contract is Tower's `docs/design/flightdeck-record-delta-v1.md`;
the exact fixture is copied to `tests/fixtures/flightdeck-record-delta-v1.json`.
`/record-sync?protocol_version=1` is negotiated before consumer activation.
404/406/501 from that endpoint selects legacy workspace sync for the current
run, including first use, a partly committed snapshot, ordinary delta polling,
and disappearance between pages. Already committed canonical/local rows, pending
commands, the v1 cursor and its generation remain intact. Fallback uses only the
persisted legacy cursor (or null if none exists), ignoring caller cursor and
force-snapshot hints. Each legacy fallback page checks the captured v1 cursor and
local authority generation in its worker transaction, so a concurrent reset or
v1 advance rejects the delayed legacy page before it can repopulate authority.
The `:record-delta-v1` cursor is distinct from the legacy cursor and is never
passed to a legacy endpoint.

Every later sync probes v1 again with its own saved cursor. A restored producer
can resume the partial snapshot/delta or explicitly reject an expired or
incompatible cursor with reset-required 409. Generic 400/409/500, transient
network errors, malformed pages and materialisation failures never downgrade.
403 still hides/purges revoked authority and throws while preserving command
recovery copies. Reset-required 409 retains the existing bounded reset/retry
path; unsupported responses during that recovery, including a persisted
`resetting` state on the next run, fail closed without a legacy request.

`forceSnapshot` remains a legacy-only refresh hint: v1 always resumes its saved
cursor. Tower authority/reset responses and the build 2117 one-time recovery
for pre-fix snapshot state can reset download authority while preserving views.
This prevents a refresh from clearing valid cached data before negotiation or
invalidating an in-flight generation merely to probe protocol availability.
Normal legacy-only callers retain their existing explicit snapshot behaviour.
Rollback fallback itself neither resets nor retires v1 authority; legacy pages
continue to apply their own explicit update/snapshot semantics.

Each maximum-200-entry, maximum-1-MiB page commits canonical rows, explicit
identity tombstones, decimal BigInt stream versions, actor identities, dependent
local rows, summaries, conflicts and cursor together. Cursor and local authority
generation compare-and-swap rejects delayed requests, including a reset racing
with the first null-cursor snapshot. Entity row-version guards also protect newer
targeted command responses. SQL timestamp strings become UTC ISO milliseconds
in local timeline indexes. Actor sidecars are identity data, not membership or
permission grants; restricted viewers do not require `/members` or `/groups`.
Referenced identities retained from earlier pages are resolved for dependent
assignment/source rematerialization.

Snapshot pages never delete by omission. Old local generations retire only
after snapshot completion and delta handover. Retirement and ACL-reset walks
read batches of 200 in the worker. Reset hides revoked authority, preserves
unresolved commands/recovery copies and keeps the legacy cursor independent.
Summary backfill commits resumable batches of 200 and yields between batches.
A page crash leaves its prior cursor recoverable; replay is idempotent.

Pending commands prevent canonical overwrites. Acknowledgements reconcile client
IDs once, preserve newer local edits and rematerialize withheld canonical rows
when a command completes. The conflict banner exposes local/shared text and an
explicit shared-version action which first keeps a durable recovery copy.
Hydrated document bytes survive metadata-only updates while the incoming
canonical version identity advances.

Resource view states are monotonic read receipts, not content conflicts. Delta
materialization keeps the greater local/shared viewed activity version, retaining
an ahead local watermark as pending for reconnect and marking it synced once
Tower catches up. Explicit receipt tombstones still remove local authority.
Each successful sync page also reconciles saved conflicts, so old read-receipt
warnings clear even on an empty delta without dropping offline read progress.

## Query and index inventory

Chronology below is updated activity order, with created-at fallback for legacy
rows and record ID as a deterministic tie-breaker. It preserves the existing
chat/comment activity semantics rather than switching silently to creation order.
Explicit keyset options use timestamp plus ID; visible Load more expands the
indexed prefix while existing chat scroll anchoring remains in place.

| Path | Previous work | New index/query | Bound and subscription |
| --- | --- | --- | --- |
| Partial messages | Read channel history | Primary-key bulkGet plus indexed client IDs | Incoming/optimistic IDs; changed rows only |
| Partial tasks | Read owner history and replace channel | Primary-key/client lookups; `pg_channel_id` for explicit complete snapshots | Incoming IDs and pending commands; omission ignored ordinarily |
| Partial comments | Read target history | Primary-key/client lookup | Incoming IDs and related optimistic rows |
| Chat roots | Scan roots/replies from channel history | channel + active + parent + time + ID | R+1 roots, keyed to selected channel and visible counts |
| Thread replies | Whole thread history | parent/thread + active + time + ID | P+1 per visible root plus active/focused thread |
| Pending/failed chat | Potential hidden fixed cap | channel + sync status | R entries; visible expansion retains older pending/failed rows |
| Multi-channel feed | Merge complete histories | Bounded query per distinct channel, bounded merge | O(channels × visible root/reply window) |
| Task board | All owner tasks, in-memory sort/filter | Multi-entry board identity + active + state + sort tuple | L+1 per state/scope; separate native indexed counts |
| Task search/filter | Whole owner tasks | substring n-gram, assignee, tag or recent-time candidate index | Candidate PKs; rows in batches of 200; exact matching; bounded visible top-L per state |
| Comment details | Entire target, deleted filter before limit | target + active + time + ID; parent + active + time + ID | L comments plus referenced parents/focused reply page |
| Overview/files sources | All messages/comments/tasks/docs | owner + active + time + ID; indexed task activity pages | 100-source prefix, explicit footer control adds 50 |
| Unread/navigation | Recompute large record collections | Small counts and per-resource attention; visible-ID bulkGet | Section/channel summaries plus visible resource identities |
| Deleted channel latest | Recompute channel history | channel + active + time + ID, reverse first | One predecessor value |

Task sort keys cover manual, created ascending/descending, modified
ascending/descending, and title ascending/descending. Title ordering is now
locale-independent, accent-insensitive natural ordering; numeric runs sort by
value. This gives the same index order across browsers. Scope descendants are
expanded through small scope metadata; channel/thread scopes use their own keys.
Derived task index arrays are removed before sending visible cards to Alpine.
Counts are actual full-match counts, not the truncated page's length.

Search preserves arbitrary substring, tag-any and assignee semantics. Exact
counts for common substring searches can still require every matching candidate;
this path is candidate-count dependent, not a constant-time guarantee. The
metadata/index storage and write cost of 14–28 board keys per task plus unique
1–3-character search tokens is intentional and measured separately. Long task
text can generate many tokens. Native count operations can walk matching index
entries internally even though they return no record values.

Inbox starts with 50 cards. Its All, Chat, Task, Docs and Files selector combines
with scope and submitted search before selecting source candidates. One footer
reveals the next 50 matching cards and expands relevant source prefixes by 50
when necessary. Type, scope and search transitions reset the visible prefix;
source subscription generations reject late results. Files retains its own
footer and source window.

Chat activity uses the existing channel/active/time index, including PG rows
cached before ownership was populated by the canonical mappers. This read-time
compatibility path requires no ownership rewrite, resync or cache reset. The
additive v26 index upgrade below populates its new derived eligibility fields. Chat candidates use bounded message and root prefixes plus one indexed latest
reply per candidate thread. Deduplication never scans a whole busy thread. Tasks/documents retain comment activity and file
classification. Native scope/channel task keys, scoped document/comment chronology, and file
presence indexes narrow candidates before reading their values. Every source
reads at most its requested prefix plus one lookahead per indexed scope/state or
channel. Arbitrary content matching happens after that bound; global task text
uses a bounded n-gram candidate prefix. A sparse content search can therefore
require explicit Load older progress. No query automatically drains history to
fill a matching card count. The retained source-prefix count is the progress
marker and grows by 50 per requested expansion; live queries reread that explicit
prefix to retain live updates and deletions, rather than using stale offset caches.

Recent Channels independently reads one indexed eligible latest message per authorized
channel, then applies the Deck scope and ten-channel display limit. Empty channels
and thread-only metadata do not become recent activity. Displayed thread attention
is read by primary key alongside Inbox and Recent rows, so their unread state does
not depend on the selected Chat message window. Feed retains its independent
WApp activity live query and its existing explicit Feed filters.

Channel metadata remains an independent, unwindowed workspace subscription and
never requires Inbox paging, recent messages or a nonempty history. Related
metadata families, documents' existing explicit history views, workrooms and
unadvertised protocol families keep their established APIs.

## Inbox conversation detail

Opening an Inbox chat starts a dedicated Deck detail subscription, independent
of the Inbox projection and selected Chat channel. It resolves the canonical
thread and source-message IDs by primary key, reads the requested reply prefix
plus one lookahead through the existing parent/active/time/ID index, and binds
message/reaction projections to workspace, conversation, open generation and
page size. Inbox refreshes never replace the detail message window. Explicit
older-reply expansion retains the existing scroll anchor behavior.

The `thread-history-page` TowerSyncService family requests one page of at most
100 messages and a targeted thread record. The materialization worker reconciles
these into Dexie, respecting pending commands, newer versions and canonical
tombstones. Paging coverage uses a separate per-thread sync-state key; workspace
sync cursors are unchanged. Only pagination/loading/error state returns to the
UI directly; messages arrive through liveQuery.

Partial pages retain previously authorized effective membership only for matching
workspace/channel/thread/source/parent/branch-point/scope lineage. Canonical
metadata-only thread updates preserve complete effective ID arrays; changed
lineage invalidates inherited coverage. ID metadata merges do not read historical
message values. Detail reads still fetch only the requested bounded values and
honor canonical tombstones. Indexed own-thread replies remain live independently
of the effective ID prefix. Legacy coverage lacking a lineage binding is not
used as independent authority; intact thread effective arrays remain usable.
Only the expected forward cursor edge advances continuation, so first-page
replays and reordered pages cannot regress it. Older thread authority is rejected
with a retry error. Authority reset removes coverage and rejects history reads
started in the prior local authority generation.

Current transport limit: Tower's existing effective-transcript endpoint exposes
only `created_at ASC, id ASC` and an after cursor. Cached recent replies render
immediately, but a completely cold conversation begins with the first bounded
page. “Load more conversation history” advances that remote cursor explicitly;
it does not claim to jump to the newest remote reply. A newest-first initial
remote page with bounded older keysets requires a separately reviewed Tower
contract extension. The existing branch hydration API is unchanged.

`node scripts/verify-inbox-thread-browser.mjs` exercises the production Alpine
store, Inbox card action, open handlers and actual thread modal in WebKit, with
in-memory transport and canonical worker fixtures. Set
`FLIGHTDECK_VERIFY_BUILT_WORKER=1` to use the packaged Vite worker and extract
Inbox/modal templates from the built index. `FLIGHTDECK_VERIFY_DIST` selects an
alternate unpacked asset directory (default `dist`), including its styles. This
can verify downloaded OTA worker/templates/styles with the real source-built
production store and fixture transport. It does not execute the complete OTA
application entry or test authenticated Tower, OTA installation, or a native device.

## Unread semantics and migration

PG unread remains resource activity-version greater than the viewer's read
watermark. Task attention excludes the viewer's own latest task/comment activity,
using the existing actor-aware comparator. Thread/document attention follows
existing resource version semantics. First-use baseline seeding uses the existing
resource-view-state endpoint with limit 1; its journal writes are included through
snapshot handover. Bulk task/Inbox read actions join persisted resource attention
with viewer watermarks because record-delta activity can advance before (or
without) a view-state row. They acknowledge the captured activity version and
refresh the active projection after acknowledgement. Review tasks follow the
same read rules without a workflow-state mutation; later activity becomes unread
again. Inbox bulk actions retain the selected scope and descendants, while the
task-board bulk action retains workspace-wide scope. Local read watermarks are
monotonic and clear attention/counts atomically before network acknowledgement. Latest channel activity is separate
from viewer-specific read state. Backfill equivalence is tested against the
existing unread projection, including self-authored activity and comments.

Dexie v26 adds local activity eligibility, file-presence and scope/type chronology
indexes. Its atomic additive upgrade derives fields on existing messages,
documents and comments without deleting rows, pending commands, drafts or cursors.
The v25 upgrade regression opens that prior schema and checks these preserved
values; the production-worker browser replay also upgrades a real ownerless mapped
message, queued command and draft before replay. The one-time upgrade cost is
separate from the measured steady-state read bounds.

Dexie v25 adds indexes/tables and backfills derived fields without deleting cached
rows, cursors or pending commands. The upgrade test opens an old-schema tab,
verifies its version-change close and preserves its cached message/command/cursor.
The one-time schema upgrade touches existing indexed rows; it is not a steady-state
delta cost. Real old-tab UI reload behaviour still needs an authenticated browser
pass. Rollback must retain the database, pending commands and both cursor keys;
never clear/recreate a workspace cache as a rollback shortcut.

## Evidence and remaining acceptance

Reproducible harnesses:

- `node scripts/benchmark-incremental-cache.mjs`: Node/fake-indexeddb, 15 samples,
  1k/10k/100k message/task/comment datasets. Synthetic engine timings are not
  browser latency evidence.
- `node scripts/benchmark-incremental-browser.mjs /tmp/flightdeck-browser.json`:
  installed Chrome, native IndexedDB, desktop and CPU4 mobile viewport emulation.
  All HTTP is fulfilled in memory. No backend, server, key or shared runtime is
  used. Optional `FLIGHTDECK_BENCH_BROWSER_CHANNEL` selects the installed channel.
- `node scripts/verify-incremental-worker-browser.mjs`: runs the actual built
  module-worker chunks against canonical fixtures and rejects a stale cursor,
  with in-memory routing and no backend.
- `tests/helpers/indexeddb-metrics.js` counts IndexedDB-delivered record values,
  delivered keys and write requests, including Dexie's hook reads. It does not
  observe storage-engine B-tree nodes or treat returned rows as rows examined.

Final numeric evidence and command outcomes are recorded in
`incremental-cache-performance-results.json` and the local manager handoff.
The rollback orchestration regressions in `tests/pg-record-rollback.test.js` use
the canonical fixtures and real Dexie transactions with injected network ports.
They cover independent cursor restoration, partial-page disappearance, access
revocation, reset recovery, malformed pages and delayed-response generation CAS.
Core regression coverage includes equal timestamps, huge threads, active/deleted
indexes, legacy timestamps, optimistic IDs, repeated/stale pages, crash atomicity,
snapshot omission/handover, ACL reset races, actor sidecars, dependent assignments,
hydrated documents, old-schema migration and unresolved command recovery.

Still required before release acceptance: physical desktop/mobile median/p95 on
agreed targets and absolute budgets, authenticated local-Tower application flow
and scroll/load-more pass, production-sized index/migration storage measurements,
and cross-component shared-runtime negotiation/ACL smoke tests. The isolated DOM
benchmark is a simple 21-row list plus two animation frames, not an Alpine render
benchmark; compositor scheduling can dominate it. No restart or deployment is
performed by this implementation.
