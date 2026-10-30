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

## Comment composers

Task comments and document comments/replies use the same local workspace roster,
picker, canonical actor pills and Markdown serialization as chat. Comment writes
preserve `person` and `agent` types in structured `mentions` and metadata; task
and document body mention contracts remain independent. Tower resolves the actual
workspace identity and read permissions, and only structured agent mentions can
instruct agents. Visible Markdown alone grants no authority.

Document comment contenteditables preserve whitespace, including the separator
inserted after a mention and authored line breaks. Their drawer and modal share
this behavior. Existing canonical tags render through the normal Markdown link
handler without rewriting stored comments.

`e2e/comment-mentions.spec.cjs` mounts the production task, document-comment and
document-reply composers with synthetic local records. It checks `@ric`, keyboard
and touchscreen selection, person and agent tags, complete multiline bodies,
intercepted sends, structured mentions, Dexie persistence and page reload. The
network and signer are isolated fixtures, so these tests do not establish live
Tower authorization or agent delivery. The comment adapter tests cover the same
canonical types and accepted-row persistence. Task replies and comment body
editing are not currently exposed by these web surfaces.

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

## Editing chat messages

Edit opens the existing thread composer for a synced message owned by the
current actor. Capture the live channel and thread editors before replacing
their contents: typing normally defers the reactive model until send. A reply
draft belongs to its original thread, while the edit uses a distinct draft and
upload key. Save and Cancel restore the target thread's reply draft; switching
to another thread must not move the source thread's draft with it. Pending
reply uploads resolve to that saved reply draft, not into the edited message.
Cancel clears only the edit draft. Existing attachment metadata remains on the
message; new file/audio attachments belong in a reply and are disabled during
text editing. Pending reply attachments remain available after editing.

Saving serializes the live composer, including actor pills, and sends the full
remaining structured actor mention set. The existing update API requires a
fresh instruction signature over the exact revised body, with the message id,
next revision and workspace/channel/thread context. Tower retains authorization
and optimistic row-version checks. A visible tag alone does not authorize a bot.

Tower compares the saved actor identities with the prior saved revision. Only
newly added agent identities are eligible for revision delivery; Autopilot
idempotency suppresses repeated delivery of the same message revision. Ordinary
text edits with unchanged mentions do not run those bots again. Removing an
agent, saving, and adding it in a later saved revision intentionally makes it
newly eligible again. No shared routing contract changes are needed.

A failed or offline Save keeps the edit text and selected mentions open for
retry and leaves the prior accepted message intact. A conflict requires review
of the latest saved version. Chat draft storage currently lives in memory;
these guarantees do not imply recovery of an unfinished edit after a full page
reload. Browser acceptance in `e2e/edit-message-mentions.spec.cjs` intercepts
all requests and signs with an isolated test identity. It verifies canonical
body, exact structured mentions and cryptographic revision signatures without
writing to a real workspace or dispatching a bot.
