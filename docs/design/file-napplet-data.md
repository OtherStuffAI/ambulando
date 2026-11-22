# File napplet data bridge

Daily tracker runs as client HTML inside Ambulando. NStack owns the HTML File,
its immutable versions, the separate JSON data File and all durable entries.
There is no tracker server or browser-storage system of record. Apps → Daily Metrics
offers explicit setup of an empty instance in the authenticated viewer's
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
make the frame inert; ordinary success preserves its DOM and draft. Changed
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

## Apps entry and stable route

Daily Metrics is a built-in, default-visible Apps entry with app ID
`daily-tracker` and placement ID `napplet:daily-tracker`. Existing placement
preferences control its visibility and order. The explicit app route is
`/flight-deck?workspaceid=<workspace UUID>&napplet=daily-tracker`; it resolves
for the authenticated viewer, without placing private File IDs or values in
launcher metadata. A hidden launcher does not disable the explicit route.

Opening checks the viewer's verified self-DM and lists active Files. Metadata
`napplet.app_id`, rather than filename, identifies existing instances. One is
adopted, several require a chooser, and none offers explicit setup. Failed or
incomplete discovery cannot provision a replacement. Full listing pages fail
closed and direct the viewer to existing Files. Setup rechecks discovery before
using the existing empty HTML/JSON provisioning path. There is no server-side
singleton primitive: simultaneous first-time setup on separate devices remains
subject to the multiple-instance chooser on subsequent opens.

App mode uses the same sandbox, reviewed-code confirmation, File bridge and
lifecycle checks, with source/history controls hidden. Legacy File links retain
the ordinary inspection and revision experience. No tracker migration occurs.

## Remembered approval on web

The first open shows a host-owned “Trust and open” screen before mounting the
frame. Approval is remembered only on this browser profile, without sync. A
visible “Forget approval” action closes the app through existing pending-save
and dirty-draft guards and removes consent, without deleting tracker data.
Unavailable receipt storage permits an explicit one-session approval and shows
that it could not be remembered. Failed removal is reported and blocks reuse
in the current session; clear site data if browser storage cannot be cleared.

Policy v1 scopes a receipt to the normalized backend URL, available Tower and
workspace service identities, app namespace, workspace, viewer, and code File.
Its fingerprint includes the SHA-256 of actual immutable HTML bytes verified
against File-version metadata, validated manifest version/app ID, exact tracker
binding File ID, format, privacy, sorted read/save operations, and fresh effective
write access. The current parser accepts only the documented single binding;
unsupported manifests are rejected before receipt lookup. Code version IDs,
filenames and data versions/values are excluded. Same-byte code revisions and
ordinary answers therefore retain approval; changed code, bindings or effective
permissions require consent again or fail authorization. One receipt per code
File replaces previous consent when approved details change.

Storage keys and values contain only policy version and SHA-256 fingerprints,
never data, credentials or signing material. Malformed/denied storage never
auto-approves. Authority is checked before lookup and again before mounting,
including when consent has been left open. Existing periodic and per-operation
checks remain mandatory: remembered approval grants no Tower authority. The host
pins effective write access at grant time and requires an exact match on every
authorization, including prepublication and result delivery. A read-only grant
cannot gain write access when server permissions broaden; reopen for fresh consent.

The data File response’s top-level `can_write` boolean takes precedence over
embedded `file.can_write`, including explicit false. Embedded access is used only
when the top-level field is absent; a present nonboolean rejects authorization.
