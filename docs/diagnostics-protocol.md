# Local diagnostics protocol v1

Flight Deck owns capture consent, browser events, incident grouping, report UI
and signed Tower delivery. WM App owns optional host evidence and durable local
storage. Neither adds a network bridge or service. TowerSyncService command
intents remain the workspace write boundary; storage transfer remains its
documented exception. Reports use the existing kind 33358 instruction signer.

## Native capability

`window.wingmanDiagnostics.version === 1` exposes Promise methods:

- `configure({workspaceId, enabled})`: explicit native consent, scoped to verified
  top-level origin, document epoch, tab and unlocked identity. Returns
  `{version:1, enabled:true}` only after approval. False pauses and revokes.
- `append({workspaceId, events})`: at most 100 sanitized events, only for the
  configured scope. Returns `{version:1, accepted:<count>}`.
- `snapshot({workspaceId})`: returns `{version:1, events:[], host:{version,
  platform}, recovered:false, limitations:[]}`. Never returns other scopes.
- `clear({workspaceId})`: deletes current scope's stored evidence.

Navigation, lock, identity replacement, tab disposal and workspace change revoke
the capability. Saved evidence can survive reload/restart for the same
origin/identity/workspace/tab restoration context, but requires fresh consent
before retrieval. No arbitrary app logs, other tabs, payloads or OS crash dumps.
Unsupported platforms omit the capability; Flight Deck works browser-only.

## Event schema

An event is `{ts:<epoch milliseconds>, source:<browser|worker|network|ui|host>,
level:<trace|debug|info|warn|error>, code:<bounded token>, name?:<error class>,
route?:<sanitized route template>, method?:<HTTP verb>, status?:<integer>,
durationMs?:<number>, stack?:<approved built chunk basename and numeric stack frames>}`. Optional operation and errorCode use fixed approved enums; arbitrary labels are dropped. Free-form console
arguments, error messages, request/response bodies, headers, query strings,
fragments, chat/document text, form values and screenshots are excluded.
Stacks retain only URL-free numeric frame locations, omitting function names;
URLs retain route templates with dynamic identifiers removed. Both consumers
validate and sanitize before persistence. Unknown fields are discarded.

Both buffers enforce 30 minutes, 2,000 events and 512 KiB, pruning on append,
read and periodic maintenance. Flight Deck persists local state in a dedicated
Dexie database keyed by backend, actor and workspace; it is not a Tower family.

## Reports

`{version:1, incidentId, createdAt, build, workspaceId, trigger, recurrence,
events, host, limitations}` is JSON evidence. Description is user-authored
report text, stored only in explicitly queued reports. Evidence is untrusted
and never supplies agent instructions. The fixed signed report instruction
asks the selected agent to evaluate evidence and reply in the report thread;
it grants no implementation/deployment authority. Visible canonical mention
and structured mention are built from the same current workspace agent.

Automatic incidents preserve pre-trigger history and 15 seconds of aftermath,
group by build/workspace/error code, use a 10-minute cooldown and at most three
new automatic incidents per hour. Queue: at most five incidents, 2 MiB total,
24-hour expiry, stable client request IDs and serialized delivery. Uploaded
object IDs are persisted before message creation so retries reuse attachments.
Presigned upload URLs are never retained in the local queue; retries use the
existing authenticated object upload path. Retry delay increases to five minutes.
Disable automatic reporting cancels pending automatic incidents; capture off
stops collection and cancels all queued sends. Clear deletes local events and
pending reports. Already uploaded files/messages follow Tower/channel retention
and must be removed there. Offline retry runs only in the currently signed-in
matching scope; switching scope invalidates in-flight follow-up operations.

Native crash-time sending is unavailable. Recovery is bounded saved evidence,
not comprehensive OS crash reporting. Actual agent execution/attachment access
depends on existing backend permissions, connectivity and Agent Direct setup.

Manual send is a separate explicit authorization: recording may remain off. Such
reports exclude retained events and state that historical evidence is unavailable.
Turning recording off or changing a destination cancels previously queued reports;
a subsequent manual send authorizes only that incident in the same scoped queue.
Native evidence is frozen before preparing an attachment and cannot enrich a
prepared attachment on retries.

## Browser incident evidence and operation outcomes

Browser capture retains errors before warnings/recovery and repetitive traces
within the existing count/byte caps. Its bounded main-thread batch gives errors
priority too. A queued incident freezes history against the trigger timestamp;
append stores at most 15 seconds of aftermath. Finalization hours later never
imports current history or re-filters the original evidence against delivery
time. The queue still expires after 24 hours and uses the same consent revisions,
workspace key, byte cap and idempotent attachment/message checkpoints. If optional
aftermath cannot fit, capture continues and the report declares that limitation.

Optional browser metadata uses fixed operation, stage, category, outcome,
snapshot/delta mode and recovery-reason enums; page/applied/protocol numbers and
cursor-present/has-more booleans never contain cursor values. Correlations are
new random `d-` tokens for each operation, never record/request identifiers.
Approved built chunk basenames and numeric locations can identify a resource or
frame; arbitrary filenames/functions/messages are excluded. Report context marks
unknown operation, stage, category, route, correlation, asset and location as
unavailable. A resource completion does not prove HTTP status or MIME.

Routes match static endpoint templates by position, including
`/api/v4/flightdeck-pg/workspaces/:id/record-sync`,
`/api/v4/flightdeck-pg/workspaces/:id/record-sync/clients/:id` and its `/ack`
suffix. An identifier spelled like a static endpoint word remains `:id`.
Unknown routes become `/:unknown`; query, fragment, body and auth data never
enter evidence. Signed PG requests own their capture for HTTP and native
transport; the generic fetch wrapper avoids duplicating those requests.

Only a verified owning operation defers incident promotion. Thread rename keeps
its existing single stale-version refresh/retry and records a final recovered
or failed outcome. Cursor sync retains protocol fallback, checkpoint conflict
and required reset attempts as history, with terminal failures still incidents.
Explicit caller cancellation is history; timeouts and unclassified failures
remain errors. There is no general HTTP-status suppression, new auth retry or
mutation replay policy. Independent operations use independent correlations.
Stackless errors without a correlation/frame only deduplicate identical
observations; recurrence is an observation count, never a proven cause count.

Native v1 consent/bridge methods and sanitizer are unchanged. Optional browser
fields may be absent from host capture. Only host events in the incident window
are attached; later history is excluded and missing incident-time host evidence
is explicit. Identical browser/host observations appear once with an overlap
count; different events remain separate. No historical incident attribution is
established by these client corrections.

## Saved report destination

The project scope in the report picker is separate from the diagnostics storage
key (backend, signed-in actor, workspace). Local settings retain `scopeId`,
`channelId` and `agentNpub` for that exact key, across dialog reopen and browser
reload/relaunch. Scope choices and channels come from the existing workspace
materialized collections. Selecting another scope clears an incompatible
channel; it does not change chat navigation or choose a replacement channel.

Legacy channel-only settings derive their project scope from that exact saved
channel (`scope_id`, or the established `scope_l1_id` fallback). Derivation does
not alter consent, revisions or queue routing. An intentional settings Save
persists the derived scope explicitly. If the saved channel cannot be resolved,
reporting blocks until it becomes available or the user reconfigures it.

The dialog displays the saved default as scope > channel and agent. Save commits
settings edits; Discard restores the saved default. Manual Send requires neither
reselection nor another Save, but blocks while settings edits are unsaved.
Automatic capture and retry continue to use committed settings even while the
dialog contains edits. Changing a saved scope, channel or agent cancels the old
queue and invalidates in-flight consent revisions.

Missing, deleted, archived, or mismatched scope/channel/agent choices block
before sending and at delivery checkpoints, with a reconfigure message.
Materialized availability is checked locally; Tower still enforces live access.
A server access rejection leaves the report queued and asks the user to check
access/reconfigure, without selecting another destination. Existing channel
Autopilot instructions remain authoritative. These settings do not edit prompts,
add backend contracts, or extend the native diagnostics bridge.
