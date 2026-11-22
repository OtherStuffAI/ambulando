# Workspace Report File napplet

Workspace Report is a default Apps entry with placement `napplet:workspace-report`
and route `/flight-deck?workspaceid=<workspace UUID>&napplet=workspace-report`.
A private HTML File in the viewer’s Note to self holds its code; no analytics
JSON File, per-app server, catalogue, schema migration or personal metric write
is involved. One existing instance is adopted, several require a chooser, and
none offers explicit setup. Incomplete discovery fails closed; uncertain setup
requires reopening discovery, never blind creation retries.

## Authoritative read contract

TowerSyncService owns a `workspace-report` on-demand query with no disk count
cache. The File command owner receives that service query; it never crawls local
message bodies. The endpoint is fixed:

`GET /api/v4/flightdeck-pg/workspaces/:workspaceId/workspace-report?range=7d|30d|90d|all&top_n=10`

The host fixes `top_n=10`. The HTTP API supports 1–50; the frame only selects a
range. Default is 30 days. NStack resolves current viewer membership and grants
before counting in one read-only repeatable-read snapshot. Its contract is
`FlightDeckPgWorkspaceReportResponse` in Tower `src/types.ts`:

- Identity, `format:workspace-report-v1`, workspace, range, UTC `from`/`to`/`as_of`,
  `complete:true`, `channel_policy:active-project-channels`.
- `activity:{messages,conversations}`: complete window totals.
- `inventory:{channels,conversations,tasks,documents,files}`: current inventory.
  Tasks has total/open/completed/archived and all nine zero-filled `by_state`
  keys: new, ready, in_progress, review, done, archive, backlog, blocked, archived.
- `channels:[{channel_id,scope_id,name,scope_name,messages,conversations}]`, ordered
  messages descending then UUID ascending.
- `ranking:{total_channels,returned_channels,has_more,other_messages,other_conversations}`.
  Shown plus remainder must equal complete activity totals.
- `coverage:{tasks_channels,documents_channels,files_channels}` counts eligible
  readable inventory channels, including channels with zero records.

Universe: active kind=channel project channels in active scopes of any kind,
with current channel.read. DMs/system channels excluded. Maximum 2000 authorized
channels; larger universes fail neutrally before history scans. Task.read is
independent; docs use doc.read OR channel.read and Files use file.read OR
channel.read, matching existing PG family policies. No analytics admin bypass.
Counts/coverage/labels never include hidden channels. There are no individual
resource grant tables in this PG model; the API does not widen such permissions.

Activity uses canonical nondeleted message IDs in their actual channel, created
in rolling `[from,as_of)` (168/720/2160 hours; all time has null from). Replies
count, inherited transcripts do not duplicate. Conversations are distinct
nondeleted threads with included messages; archived threads retain activity.
A message on a deleted thread still counts as a message, but its thread does
not count as a conversation. Current conversation inventory excludes archived
and deleted threads and is independent of the window. Task completed=done,
archived=archive+archived, open=all other states; no updated_at completion
inference. Docs/Files count current nondeleted unarchived logical rows once,
not versions or storage objects. Unknown states, unsafe counts, excessive labels,
timeouts and oversized responses fail without partial totals. Server response
budget is 64 KiB, statement budget ten seconds, and Cache-Control is no-store.

The browser validates exact keys, identity/context/range/time boundaries, safe
counts, unique channels, sorted ranking, complete totals and remainder, and task
sums before rendering. Inventory coverage is shown explicitly. Loading, refresh
and failures clear counts. No offline snapshot is presented as current.

## Manifest and host boundary

Exactly one JSON script `wingman-napplet-manifest` declares:

```json
{"version":1,"app_id":"workspace-report","bindings":{"report":{"format":"workspace-report-v1","operations":["read"],"privacy":"viewer"}}}
```

Host-owned File metadata `napplet` is:

```json
{"version":1,"app_id":"workspace-report","bindings":{"report":{"workspace_id":"<workspace UUID>"}}}
```

The workspace must equal the live host context. A separate parser and command
owner leave the narrow Daily Metrics parser/data/Update app behavior unchanged.
Ordinary HTML remains bridge-free. Verified immutable HTML digest and File
version anchor execution; its code File must remain in the viewer’s self-DM.

The opaque-origin sandbox receives a random `window.nappletSession`. Requests
have exact fields `{type:"wingman-napplet-data",version:1,session,requestId,
operation:"read",binding:"report",range}`. Frame window, null origin, nonce,
bounded ASCII unique ID and range enum are required. No workspace selection,
URL, query, SQL, write, signer or credential primitive exists. One operation
runs at a time, with a 45-second deadline and 10,000 request-ID session budget.

Success is `{type:"wingman-napplet-result",version:1,session,requestId,
status:"ready",value:<validated aggregate>,canWrite:false,privacy:"viewer-channels"}`.
No aggregate base version or private error payload exists. Failure destroys the
frame and shows a host retry instruction. Foreground, 30-second and existing
SSE/fallback invalidation checks reauthorize code and reread the report through
TowerSyncService; unchanged current request ID can receive a refreshed aggregate.
A user range request arriving during a check is queued. Context changes, close,
pagehide, denial, code/binding/access change and timeout stop/abort the owner and
destroy data. A queued authority invalidation during a read forces another fresh
read before delivery. Standard host checks do not promise instant per-channel
revocation; displayed as_of always describes the server snapshot.

First launch asks host-owned consent. A device-local receipt hashes normalized
backend, Tower/workspace service, app, workspace, viewer, code File, exact verified
bytes, manifest, workspace binding and fixed read-only capability (plus effective
code File write access). New accessible channels/counts are dynamic data, not
new requested capabilities and do not repeatedly prompt. No authorization
fingerprint is used. Fresh NStack authorization is always required. Forget
approval closes the frame and removes the receipt, leaving code/data untouched.
The prompt retains the web self-navigation risk: CSP is not network isolation.

Source is `public/napplets/workspace-report/v1/`. Package identical inline HTML:

```bash
bun scripts/package-workspace-report.mjs <output.html>
```

Tests use synthetic records. Real authorized service smoke and installed native
validation are separate evidence; source/build success does not establish either.
