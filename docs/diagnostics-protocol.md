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
