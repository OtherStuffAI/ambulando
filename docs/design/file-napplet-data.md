# File napplet data bridge

Daily tracker runs as client HTML inside Ambulando. NStack owns the HTML File,
its immutable versions, the separate JSON data File and all durable entries.
There is no tracker server or browser-storage system of record. The existing
Docs/Artefacts action creates an empty instance in the authenticated viewer's
Note to self conversation. Existing File pins and links reopen it without a canvas.
The code and data are separate Files; sharing source bytes does not grant data access.

The first implementation deliberately accepts only the daily-tracker-v1 format
and a single tracker binding. Ordinary HTML has no data bridge. Host commands
reuse the signed File storage/version API, following the existing board command
owner pattern. Memory holds unsaved drafts; closing them discards those drafts.
The 1 MiB document limit, 200 metric limit and 36,600 calendar-day limit are
validated by both host and bundle.

## Privacy and trust

The host checks the data File's current channel on every read and save: it must
be a self-DM whose single participant is the current viewer. Tower enforces
normal File/channel permissions independently. This is private conversation
storage, not encryption that excludes NStack administrators or storage operators.
No workspace-wide org-data definition is used. Creation never imports prior
records or writes sample health values.

A host-owned prompt describes data use before enabling reviewed code. Web HTML
uses the existing opaque-origin sandbox and host CSP. It cannot fetch resources,
access the parent, select a signer or issue arbitrary requests. As documented for
HTML artefacts, web self-navigation can still send values out before the host
replaces a navigated frame. Run only code trusted with the bound data. Native
hosts retain network and navigation blocking.

## Manifest and binding

Exactly one JSON script with id `wingman-napplet-manifest` declares:

```json
{"version":1,"app_id":"daily-tracker","bindings":{"tracker":{"format":"daily-tracker-v1","operations":["read","save"],"privacy":"self"}}}
```

The code File retains normal HTML artefact metadata and adds a host-owned
`napplet` object. Its shape is `{version:1, app_id:"daily-tracker", bindings:
{tracker:{file_id:"<data File UUID>"}}}`. The frame cannot choose or replace IDs.
The host anchors authorization to the selected immutable code version; changed
code or metadata requires reopening.

The host injects random `window.nappletSession` before code executes. Requests
have `type:"wingman-napplet-data"`, `version:1`, `session`, a bounded ASCII
`requestId`, and `operation`. A read adds `binding:"tracker"`. A save additionally
adds `baseVersionId` and a complete `value`. A dirty notification adds only a
boolean `dirty`. The host requires exact keys, current session, exact frame
window and opaque origin. No URL, workspace, SQL, credential or signer operation
exists. Replayed request IDs do not run twice.

Replies have `type:"wingman-napplet-result"`, `version:1`, `session` and
`requestId`. Success adds `status:"ready"`, `baseVersionId`, `value`, `canWrite`
and `privacy:"self-channel"`. Errors add `status:"error"`, `code` and a neutral
`message`. Codes are `conflict`, `invalid` or `unavailable`; errors contain no
private values.

## Saves and lifecycle

Reads verify content type, size and SHA-256 of exact immutable data versions.
Saves validate historical metric compatibility, reauthorize before upload and
again before publishing, and use the original `base_version_id`. Success requires
readback of the exact acknowledged version and submitted value. A concurrent
save, an uncertain acknowledgement or a failed read never silently advances the
local base. The user explicitly reloads to discard and reconcile a draft.

Periodic 30-second and foreground checks reauthorize an open host. Existing sync
invalidation/fallback paths also request authorization checks. Pending checks
make the frame inert; ordinary success preserves its DOM and draft. Narrowed
write access, denied/error checks, context changes, close, pagehide and navigation
tear down the frame/bridge. Late results cannot deliver into a new context.
Voluntary close and source/history changes ask to discard a dirty tracker;
pending writes block those actions. Network operations have a 45-second bound.

## Tracker format and packaging

The JSON document contains `format:"daily-tracker-v1"`, ordered `metrics`, and
`days` keyed by validated local-calendar `YYYY-MM-DD` strings. A metric has UUID
`id`, `label`, boolean/number `type`, optional-display `unit` string, and
`archived` boolean. Each day maps metric IDs to booleans or finite numbers.
Absence means unanswered; false and zero are values. Archived metrics preserve
history; used metric types cannot change. Calendar dates never use UTC slicing.

Source lives in `public/napplets/daily-tracker/v1/`. Package identical inline HTML
for native hosts or a NStack code File with:

```bash
bun scripts/package-daily-tracker.mjs <output.html>
```

Browser first-run packaging uses the same function. The command prints bytes
and SHA-256 for cross-host verification. Tests use synthetic records; authenticated
human persistence and installed native verification remain separate evidence.
