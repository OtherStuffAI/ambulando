# Common napplet runtime protocol v3

This is the frozen common cartridge manifest and frame protocol. It complements
rather than changes File v1/v2. Backend installation/authority envelopes are owned
by NStack; publisher claims inside HTML never establish publisher authority.

## Manifest

Exactly one JSON script with id `wingman-napplet-manifest`. Exact manifest keys
and examples are in [manifest.json](../../tests/fixtures/napplet-runtime-v3/manifest.json).
`src/napplets/runtime-protocol.js` is the web validator.

- `version`: 3. `napplet_id`: stable `[a-z][a-z0-9_-]{0,63}`, independent of
  title, bundle version or File id. One installation per workspace/app/napplet.
- `bundle_version`: nonempty text, at most 64 Unicode scalars. Title 1–80, icon
  1–8 scalars; controls/unpaired surrogates forbidden. Icon forbids `< > : / \\`.
- `runtime`: exact `{protocol:3,min_host:<positive safe integer>}`. Host protocol
  version is 3; a higher minimum fails with a compatibility explanation.
- `collections`: object, at most 32 named declarations. Each name uses the
  napplet identifier grammar. Exact declaration keys: `scope` (`personal` or
  `team`), `schema_version` (positive safe integer), `operations` (nonempty,
  unique subset of `list,get,create,update,delete`).
- `capabilities`: object, at most 32 named declarations. Exact declaration keys:
  `version` positive safe integer, `resources` unique text array (max 64; each
  1–2048 scalars), `operations` nonempty unique identifier array (max 64).
  Personal capabilities fail unsupported on hosts without an implementation.
  Reserved `nostr-dm@1` operations are separate `read`, `decrypt`, `send`,
  `persist` (plaintext persistence), `agent` grants. No ambient signer or keys.

Use existing v2 JSON safety/canonicalization limits: plain object, 1 MiB,
32 levels, 50,000 nodes, safe finite numbers, duplicate/unsafe keys rejected.
Unknown manifest/declaration keys fail closed. Unsupported capabilities are
parseable for an honest compatibility message, never silently granted.

## Authority and update consent

NStack's authenticated installation response binds workspace, app npub, stable
napplet identity and authorized publisher to immutable bundle File/version/digest.
Clients check bytes against digest and manifest identity against installation.
A self-declared publisher in HTML is not accepted. Server permissions remain
mandatory for every collection operation; namespaces do not authorize access.

Device approval is scoped to backend/Tower/workspace service, workspace, app,
viewer and napplet, plus authenticated publisher. Approval covers collections
(name, personal/team scope, schema version, operations) and personal capabilities
(name, version, operations, resources). Code digest, display title and bundle
version are excluded from access comparison, while integrity remains mandatory.
Only subset requests load automatically. New names, broader operations/resources,
scope changes, schema changes or publisher changes need review. Decline preserves
the prior compatible bundle; rollback never silently reverses a data migration.
Audience discovery/open is separate from data grants and personal host grants.

## Frame requests

Exact examples: [requests.json](../../tests/fixtures/napplet-runtime-v3/requests.json).
Host injects `window.nappletSession`, 32 lowercase hex nonce. Every request has
`type:"wingman-napplet-data",version:3,session,requestId,operation`.
`requestId` is `[A-Za-z0-9_-]{1,64}`, unique per mounted frame.
The exact mounted contentWindow and opaque `null` origin are required on web.

- `dirty`: adds boolean `dirty`, no collection, no reply.
- `list`: adds `collection,limit,cursor`; integer limit 1–100; cursor null or
  opaque string 1–2048 code units.
- `get`: adds `collection,record_id`.
- `create/update`: adds `collection,record_id,base_revision,value`.
- `delete`: adds `collection,record_id,base_revision`.

Record IDs use `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`. Create base revision is 0;
update/delete require positive safe integer. Value is a JSON object under the
same safety limits. No workspace/app/viewer/publisher/owner override in frame
arguments; host binds these. Operations must be declared and approved, and NStack
must authorize them. Pagination never implies complete data when a cursor remains.
One operation in flight, 45s deadline, max 10,000 request IDs. Ignore malformed,
forged/replayed requests. Context switch/revocation clears frame and pending data.

Success reply: `type:"wingman-napplet-result",version:3,session,requestId,
status:"ready",result:<server-confirmed operation result>`. Error uses the same
common keys with `status:"error",code,message`; codes `conflict`, `unavailable`,
`unsupported`. Never retry uncertain mutations automatically. Online-only.

The HTTP mapping below follows the agreed NStack wire contract.

## NStack API and bot publication

The current API is rooted at
`/api/v4/flightdeck-pg/workspaces/:workspaceId/apps/:appNpub/napplets`.
API versioning is independent from manifest version 3. Its authoritative contract
is NStack `docs/contract/napplet-runtime-v1.md` in the current Tower checkout.
Installation responses bind `workspace_id,app_npub,napplet_id,publisher_npub,
bundle,manifest,revision,removed,audience_npubs`. Bundle is
`{file_id,file_version_id,sha256_hex}`. Discovery uses bounded
`GET ?limit=100&after=<cursor>` and `{installations,next_cursor}`.

Shared viewers load `GET /:nappletId/bundle` through SyncService, using their
own authenticated identity. That endpoint authorizes the published active bytes
without granting arbitrary source File access. Hosts rehash bytes and require
exact manifest equality. Prior-version bytes are not exposed by this endpoint;
a viewer unable to read a previously approved source File receives an explicit
compatibility error. Pending expanded releases keep the previous active bundle.

Collections use `/:nappletId/collections`; rows have UUID `id`, stable `name`,
`scope,schema_version,owner_npub,read_npubs,write_npubs,revision`. A personal
collection owned by the current actor is preferred. Otherwise a unique matching
name/scope/schema is required, or an explicit host selection from authorized
rows. Selection never comes from a frame owner/namespace argument. Switching a
selection clears and remounts the private frame. Reads and writes resolve current
collection authority; periodic/focus checks revalidate every used collection.

Records use `/:nappletId/collections/:collectionId/records/:recordId` with
`expected_revision` mapped from frame `base_revision`. PUT body is
`{expected_revision,schema_version,data}`; DELETE body is `{expected_revision}`.
Records are limited to 256 KiB. Replies retain `collection_id,id,revision,
schema_version,data,deleted` metadata; list uses `{records,next_cursor}`.
Writes are read back through local projection before a successful frame reply.

Use the existing broker-backed publisher, with the agent's own authorized
identity and explicit management delegation. It never receives raw keys:

```bash
node scripts/napplet-cartridge.mjs --id <stable-id> --title '<title>' --output <bundle.html>
node scripts/publish-napplet.mjs --tower <origin> --workspace <workspace-id> \
  --app <app-npub> --html <bundle.html> --channel <authorized-channel-id> \
  --requester <requester-npub> --publisher <publisher-npub> --delegation <delegation-id>
```

The helper uploads the completed HTML into existing NStack File storage and
calls PUT installation with requester-only initial audience. No new service,
catalogue or database. Existing immutable Files can be supplied with `--file-id`
and `--version-id`. A capability-broker denial is a real blocker; do not fall
back to user keys or impersonation. The requester's discovery grants, collection
grants and personal approvals remain separate.

For an update, use the same stable ID in the new manifest, increment
`bundle_version`, and pass `--update --expected-revision <installation-revision>`.
For a new version of an existing code File also pass `--file-id <id>
--base-file-version-id <current-file-version>`; otherwise publish a new immutable
code File in the authorized channel. The registered publisher alone can post
`/:nappletId/releases`. Compatible access activates automatically; expanded access
stages `pending_release` for a human manager's explicit approval.

## Legacy preservation

Existing v1/v2 File apps remain unchanged and usable. The explicit import in
Access and data verifies a JSON File in the viewer's private self conversation,
checks an immutable version and digest, and imports its whole object as
`legacy-snapshot` into the viewer's own personal collection. The receiving app
must explicitly support that object format. The user reviews source/version and
confirms compatibility. Server migration is additive, create-only, bounded and
provenance-linked; conflicts do not overwrite existing records. Source Files and
all original history stay untouched, including when napplet collection data is
deleted later. Destructive transformations and automatic legacy conversion are
unsupported. Larger/incompatible JSON requires a separately reviewed migration.

Reinstall reads `GET /:nappletId` first. Removed metadata (owner/publisher or
install-manager only) exposes `removed:true` and its current `revision`, while
bundle/data routes remain unavailable. The client uses that exact revision to
reconnect the original requester/publisher namespace. An already active install
opens idempotently; it is never duplicated or rebound to a different publisher.
Fresh/reinstall needs the canonical `napplet.install` permission or scoped
owner-issued management delegation. Publishing additionally needs the selected
publisher's current `napplet.publish` permission and source channel access.
