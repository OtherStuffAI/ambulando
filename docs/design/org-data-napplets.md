# Organisation data napplets

The default Organisation Data Catalogue, People, Organisation chart and Holiday
viewer share Tower's workspace-scoped `org_data` records. The catalogue creates
simple typed definitions/relationships and generates record tables and forms.
Tables render 50 records at a time. Person IDs link the chart and availability
views to the same person edited by a human or authorised agent.

TowerSyncService owns the typed snapshot read and mutations. A dedicated worker
validates the complete identity-bound snapshot and removes undeclared fields.
The result persists in the workspace Dexie `org_data` projection, partitioned by
backend/service, app, workspace, owner and viewer. liveQuery supplies Alpine and
the host bridge. There is no independent UI polling or napplet network access.
SSE emits payload-free org-data invalidations; the existing background fallback
also reauthorizes an open host. Loading/error never renders an old snapshot as
current. Superseded requests, disposed services and context changes cannot commit
late results. The projection is not an encrypted sync family or an outbox queue.

The host follows [Message activity](message-activity-napplet.md): native dialog,
focus containment/restoration, narrow header controls, app-local view history,
forward branch truncation and ellipsis refresh/expand/close. Reopening the active view focuses its existing modal. Expansion changes
only a CSS class and preserves the exact iframe, token, navigation and drafts.
Escape dismisses a menu first. Explicit navigation, refresh or close asks before
discarding dirty edits. A pending write blocks those actions until its outcome.
An authority/context switch or pagehide destroys the frame immediately, including
unsaved edits, because data from the old context must not remain visible. Context
invalidation takes priority over retaining a draft in a different workspace.

The frame is an opaque-origin `allow-scripts` sandbox. Native form submissions
are disabled. Generated forms validate locally and send named write commands
from button/Enter handlers; they do not need `allow-forms`. Writes include the
Tower revision. Failed saves display the clear error, retain the editable draft
and remove the previously authorised read projection. A shared-data invalidation
during an edit leaves the draft and warns that Save checks its original revision;
Refresh discards it and reauthorizes. It never silently overwrites a stale edit.

Linked initial avatars ask the host to open the existing identity card or DM
flow using only an authorised person record/member identity. External avatar
URLs are not fetched by the sandbox. Unlinked people remain usable. A Nostr or
actor link never adds membership; Tower validates references and DM authority.

## Versioned static bundles

Tower stores immutable workspace-scoped HTML versions/digests/capability manifests
and revision-checked installations. The catalogue can publish, install and launch
them without a WApp process. The host loads the installed HTML as `srcdoc` with a
host-owned CSP prepended. Scripts/styles must be inline; no external connections,
forms, nested frames, objects or parent access. There is no claim of NIP-5D
conformance. Installed launchers appear in Toolbox following the authorised
catalogue read; reload can discover them from Catalogue → Static napplets.

Bridge v1 uses `{version:1,session,type,...}`. For installed bundles the session
is `window.nappletSession`; built-ins use their URL fragment. The host accepts
only the exact frame window, `origin:'null'`, current random session and exact
message keys. Intents:

| Type | Extra fields | Effect |
| --- | --- | --- |
| `ready`, `refresh`, `close` | none | Initialise, reauthorize, close |
| `view` | `view`: catalogue/people/chart/holidays | Traverse a built-in view |
| `dirty` | `dirty`: boolean | Report pending edits |
| `write` | `path`, `method`, `body` | Named typed operation through sync command |
| `profile`, `dm` | `id`: person record ID | Existing host navigation |
| `bundle` | `key`: installed bundle key | Host launches that installation |

Host responses are `type:'state'`, `status:loading|ready|error`, `view`, and an
explicit read projection only when the bundle declares `org_data.read`.
The host hides installed bundle content while loading or after read errors,
so the frame cannot keep a stale authorised view visible. Loading/errors omit records; a save error can include `retainDraft:true`.
Write paths are restricted to bootstrap, definitions, typed records and the
built-in catalogue's publication/install controls. A published bundle cannot
publish, install or launch another bundle. Schema/record/profile/DM intents require the
corresponding declared capability; Tower grants remain an independent requirement.
No arbitrary URL, SQL, signer, credential or workspace selection intent exists.

The Tower API contract and broker-backed agent CLI are documented in Tower's
`docs/contract/org-data-v1.md` and OpenAPI. Browser fixtures are synthetic local
contract evidence; manager activation and authenticated human/agent smoke are
required before claiming live acceptance.
