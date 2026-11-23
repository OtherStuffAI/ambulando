# Generic File napplet protocol v2

Status: existing File-backed implementation reference, not the full agreed product
contract. [The agreed contract](napplet-contract.md) supersedes this document
for intended behaviour. In particular, digest-triggered consent, explicit update
checks and pin-only removal below describe current limitations, not requirements
for the next runtime. Collections are not implemented by this File protocol.
See [implementation gaps](napplet-contract-gaps.md). Do not change the deployed wire
format or migrate existing data merely by reinterpreting this document.

This protocol grants capabilities by ID and version, never by app ID. v1 remains
unchanged. Code and data are existing NStack Files. Installation is a personal
File pin; uninstall removes only that pin. Every launch verifies current code
bytes, metadata and live authority before consent. Ordinary HTML has no bridge.

## Manifest and resource metadata

Exactly one JSON script with id `wingman-napplet-manifest`. Exact keys:

```json
{"version":2,"app_id":"example-app","title":"Example","icon":"🌱","bindings":{"entries":{"capability":"private-json-file","version":1,"operations":["read","save"]}}}
```

`app_id` matches `[a-z][a-z0-9-]{0,63}`; binding matches
`[a-z][a-z0-9_]{0,31}`; exactly one binding. Title is 1–80 Unicode
scalars with no controls. Icon is 1–8 scalars, no controls, `<`, `>`, `:`, `/`
or `\\` (local text/emoji only). No external icon URLs. Strings must have
paired UTF-16 surrogates. Operations are exact ordered arrays. Private JSON allows `["read"]` or
`["read","save"]`; aggregate allows only `["read"]`. Save requests require the
approved manifest declaration as well as live write authority. Effective
canWrite in results and receipts is live can_write AND declared save.

Code File metadata contains `napplet` with exactly:

```json
{"version":2,"app_id":"example-app","bindings":{"entries":{"file_id":"11111111-1111-4111-8111-111111111111"}}}
```

UUIDs use lowercase hex canonical 8-4-4-4-12 text. JSON resource is readable in
current workspace, single-participant self-DM belonging to current viewer.
If the response owns a top-level `can_write` key, it must be boolean and
is authoritative (false overrides nested true). Only when that key is absent,
use `file.can_write`, which must be an explicit boolean. Null, malformed or
missing authority fails closed; never fall through a present malformed top key. Read-only access is supported;
save never exceeds the approved effective grant. No provisioning/rebinding.
Shared code is allowed by ordinary File ACL. Archived/deleted Files/channels fail.

The other registry entry is `workspace-aggregate@1`, operations `["read"]`;
metadata resource is exactly `{"workspace_id":"<current workspace UUID>"}`.
It uses the existing workspace-report-v1 aggregate validator and fixed top ten,
range `7d|30d|90d|all`. No arbitrary queries or approximate missing-API counts.

## Wire

`session` is the host's 32 lowercase hexadecimal nonce, exposed to the document
as `window.nappletSession`. Source must be exact mounted contentWindow,
origin `null`. `requestId` matches `[A-Za-z0-9_-]{1,64}`. Exact operation keys:

```json
{"type":"wingman-napplet-data","version":2,"session":"0123456789abcdef0123456789abcdef","requestId":"r1","operation":"read","binding":"entries"}
{"type":"wingman-napplet-data","version":2,"session":"0123456789abcdef0123456789abcdef","requestId":"r2","operation":"save","binding":"entries","baseVersionId":"11111111-1111-4111-8111-111111111111","value":{"zero":0,"answered":false}}
{"type":"wingman-napplet-data","version":2,"session":"0123456789abcdef0123456789abcdef","requestId":"d1","operation":"dirty","dirty":true}
```

Aggregate read adds only `range`. Capability/resource IDs are never frame args.
Dirty has no binding and no reply. Every accepted request ID, including dirty,
is single use; at most 10,000 IDs per run. One operation in flight. Busy requests
are ignored without consuming IDs. Deadline 45 seconds, authority checks every
30 seconds and on focus/visibility; context loss/navigation/close aborts and
removes private frame DOM. Healthy authority checks preserve draft DOM.

Exact success keys for JSON:

```json
{"type":"wingman-napplet-result","version":2,"session":"0123456789abcdef0123456789abcdef","requestId":"r1","status":"ready","baseVersionId":"11111111-1111-4111-8111-111111111111","value":{"zero":0,"answered":false},"canWrite":true,"privacy":"self-channel"}
```

Aggregate success omits baseVersionId, canWrite false, privacy viewer-channels.
Exact error keys: type/version/session/requestId/status/code/message. status
`error`; code `invalid|conflict|unavailable`; messages respectively
`Invalid request.`, `A newer version exists.`, `Operation could not be confirmed.`.
Malformed/untrusted envelopes and replay are ignored. Authority loss tears down.
A missing aggregate API returns unavailable; it never fabricates counts.
CAS conflict and uncertain acknowledgement never retry automatically.

## JSON and canonicalization

Whole-object replacement, domain validation belongs to bundle. Root must be a
plain JSON object, max 1,048,576 UTF-8 bytes, depth 32 (root depth 1), 50,000
nodes (every value including root), each key/string max 65,536 UTF-8 bytes.
No unsafe keys `__proto__`, `prototype`, `constructor` at any depth. No unpaired
surrogates, nonfinite numbers, negative zero or numbers with absolute value
above 9,007,199,254,740,991. Null, false, zero and absent keys stay distinct.
Duplicate JSON keys are rejected on decoding. UTF-8 must be strict, no BOM.

Canonical JSON recursively sorts object keys by Unicode scalar value, uses
compact JSON strings (literal non-ASCII, JSON control escaping), arrays retain
order. Numbers use ECMAScript JSON.stringify representation; other runtimes must
match (including decimal exponent thresholds). SHA256 uses UTF-8 canonical bytes.
Private data storage uses these canonical bytes and exact acknowledged readback.

## Consent receipt v2

Namespace `napplet-approval-v2:`. Backend is absolute http(s) URL, no credentials,
URL-normalized, trailing slash removed. Identity ordered array:
`[backend,tower||"",service||"",appNpub,workspaceId,viewer]`.
Slot suffix is SHA256(canonical JSON `[...identity,codeFileId]`). Fingerprint:
SHA256(canonical JSON object with exact keys
`{version:2,identity,codeFileId,digest,manifest,resources,canWrite}`).
`manifest` is the exact validated manifest; resources is exact metadata bindings;
digest is verified lowercase SHA256. Data versions/values and aggregate inventory
are excluded. Stored value exactly `{version:2,fingerprint}`. New bytes/bindings/
effective grant prompt once; unchanged launch rechecks authority without prompt.
v1 keys/fingerprints are never interpreted as v2 grants. Code File current head
is immutable for each mounted run; explicit Check for update reopens same File.
