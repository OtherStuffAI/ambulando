# Chat mention hydration

The workspace member directory in Dexie is the authority for selectable PG
person and agent identities. Actor sidecars resolve record attribution; they
must not substitute for workspace membership. Channel visibility still comes
from the existing participant, group and grant rules.

Load cached members before local channel selection can open a composer. Keep
the workspace member subscription active independently of remote directory
requests. A failed or explicitly incomplete directory read cannot replace the
downloaded roster with a self-only fallback. A successful complete directory
read still replaces eligibility, including removal of retired identities.

PG subscription queriers must begin their Dexie reads without first awaiting
a foreign promise such as a dynamic import. That await can lose Dexie's
observation context: the initial read succeeds, but later local writes no
longer deliver updates. Keep cursor-key imports outside the querier, including
the navigation projection querier. The subscription lifecycle continues to
fence deliveries by workspace key and selection generation.

The authoritative shell lifecycle installs a local reactive effect for the
open mention picker. It observes replacements of eligibility and label inputs,
coalesces recomputation into a microtask, and reads the current composer and
channel when recomputing. Closed pickers do not scan history or initiate reads.
The people cache includes workspace metadata and scopes alongside roster,
groups, channel grants and profile inputs. Typing continues to reuse cached
people between source changes.

Regression coverage lives in `section-live-queries.test.js` for actual Dexie
updates and stale delivery, `workspace-manager.test.js` for warm bootstrap,
`channels-manager.test.js` for failed/incomplete reads and authoritative removal,
and `mention-channel.test.js` for local picker updates and isolation.
`e2e/membership-mentions.spec.cjs` exercises the rendered production picker and
canonical structured agent insertion using synthetic local data with network
requests unavailable. It is distinct from authenticated live verification.

## Full reconciliation freshness

Only the workspace `members` and `groups` directory GETs use a 24-hour policy.
Their complete transport snapshots and last successful full-reconciliation times
live in workspace Dexie `sync_state`, keyed by backend URL, app, workspace and
family. They survive reloads. The shared API boundary covers mention requests,
reference-directory bootstrap, actor fallback and ordinary worker reads. Legacy
`force` flags on editor-opening callers do not bypass this policy. A cold cache
reads promptly; due reads coalesce. Cache-hit responses are marked locally: consumers retain
current Dexie rows rather than replay older transport snapshots. Explicit hints
arriving during a read trigger a coalesced follow-up; hints during that follow-up
advance its dirty generation until the latest observed changes are reconciled. The UI continues to render its persisted
rows while a background request is slow, offline, malformed or incomplete.
Failures retain rows and timestamps, with a 30-second retry cooldown. An empty
successful directory is authoritative, rather than a failed-read fallback.

The existing visible-session background sync cadence checks these directories;
focus, visibility and reconnect already wake that lifecycle. No new timer or UI
network polling is installed. Directory errors do not gate record sync. A
captured Dexie handle and existing workspace selection fences prevent old
requests from materializing into a newly selected workspace.

Live updates are event-triggered authoritative reads, **not roster deltas in
SSE payloads**: `workspace_member`, workspace/actor profile and actor hints reread
members; group/member hints reread groups. These reads bypass the day gate and
replace the cached snapshot without advancing the full-reconciliation deadline.
The existing Dexie subscription and open-picker effect deliver additions,
renames and removals. Channel-grant hints retain their targeted channel/grant
reads; canonical record sync supplies channel/scope access changes. Profile
resolution and unrelated record families keep their independent policies.
Local People edits, membership additions and group writes use an explicit
`mutation` read reason; an explicit `manual` reason is also supported. Ordinary
settings initialization is not an explicit refresh. Server permissions and
structured person/agent mention routing are unchanged.

Whole-group omission retirement retains its existing behavior: group refresh
replaces the visible array and upserts persisted groups, but does not delete
omitted group rows from Dexie. A previously downloaded whole group can therefore
reappear as a stale suggestion through local subscriptions or after reload.
This policy change deliberately adds no destructive group cleanup. Removal of
a member within a returned group updates that group's membership; complete
workspace-member reads still remove retired roster identities. A mention never
grants server access.

## Record and chat-thread mentions

The @ lookahead also offers records: documents, tasks, channels, scopes, flows,
opportunities and chat threads. It filters them by case-insensitive substring on
their label. Selection inserts the canonical `@[Label](mention:<type>:<id>)`
markup as an atomic pill. Only `person` and `agent` mentions add structured
routing `mentions`; record mentions live only in the body and grant no access.

Chat threads use type `chat` and the channel-qualified id
`<channelId>#<rootId>`, the same form as "FD Ref". `normalizeRecordLinkType`
reads `thread`, `message` and `chat_message` as `chat`, so writers should always
emit `chat`. Candidates come from the workspace Dexie root index
`[cache_parent+cache_active+cache_time+record_id]`. Bare `@` uses only the
newest 500 cached roots across channels, refreshed at most every 30 seconds.
A typed query also scans every cached root, newest first, until 40 match its
title or body (`findChatRootsMatching`), so older threads are still found by
name. Both reset when the workspace changes, and a stale scan cannot replace a
newer one (`src/chat-thread-mentions.js`). A thread record whose
source message is cached is represented by that message, as in the main feed.
Labels drop markup and brackets and are capped at 80 characters, so inserted
markup stays parseable. The `thread:` prefix restricts results to threads;
`chat:` remains the channel alias. Opening a `chat` pill calls
`openLinkedThread`, which rejects a channel mismatch or an unreadable message.
