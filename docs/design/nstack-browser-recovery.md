# NStack browser discovery and encrypted recovery v1

Ambulando consumes an injected `window.NStack`; it does not install or emulate a
production provider. `src/nstack-provider.js` is the stable boundary around the
approved v1 methods. Availability reveals only the protocol version. Stack and
workspace lists stay inaccessible until `requestDiscovery()` succeeds. The
adapter accepts opaque bridge IDs only for calls back to that document and
strictly validates the safe real connection metadata disclosed for each selected
workspace. It never asks for signer, Nostr, Blossom or service capability handles.

The deterministic provider in `tests/fixtures/` is contract evidence, not a
browser global. Nostr Browser can replace that fixture without changing the
manager or Settings UI. The provider must enforce origin consent and return
origin-specific IDs. It must never return administrator credentials, private
keys, signer/bunker/NWC secrets, cookies, database credentials, bearer tokens or
another reusable raw capability token.

The provider surface follows NBrowser v1 exactly. Stack summaries retain their
opaque `id`, label and availability and may include safe refresh metadata.
Workspace summaries add the real Tower workspace id, owner and workspace-service
npubs, canonical HTTPS Tower URL, Tower service npub and optional paired FIPS
metadata. `change` carries only `{reason}` and is a prompt to discard all disclosed
summaries and explicitly discover again; the event is not authority. Early
document injection is handled through the provider ready promise/event with a
bounded fallback.

Choosing a disclosed workspace builds the same `wingman_workspace_locator` used
by manual Tower PG setup. Ambulando fetches Tower's descriptor and `/me` with
fresh exact `window.nostr` NIP-98 signatures, compares every disclosed stable
identity with Tower's response, then—and only then—persists and selects the
verified workspace. A declined prompt, malformed/mismatched descriptor, failed
Tower verification, empty list, or provider change preserves the active
destination and the manual-add path.

### Separate NBrowser recovery record

NBrowser owns its browser-host bootstrap record: one self-encrypted kind-30078
event with `d=org.wingman.nbrowser.settings.v1` that points to one immutable,
encrypted settings snapshot object. Ambulando neither reads nor writes that
address and never presents its contents as provider records. The richer records
below use a separate Ambulando namespace and remain independently replaceable,
application-owned configuration recovery records.

## Local selection boundary

The selected stack/workspace summary is stored in shared Dexie under an exact
`origin + Nostr identity + local Ambulando workspace` partition. Opaque IDs and
labels are persisted only to restore UI choice. They are never treated as real
workspace identity or service authority. A restored choice does not switch the
active destination: the user must review it and complete fresh Tower verification.

## Unified setup projection

Settings presents one NStack collection. Every saved/manual Tower or Supabase
server is projected as an NStack immediately, with its saved workspaces nested
beneath it and the active route shown as `NStack → workspace`. The projection
does not rewrite legacy settings or create another transport path.

Consented `window.NStack` results enter that same collection and are never merged
by label or opaque origin-scoped ID. Ambulando may merge the browser entry with a
configured NStack only when normalized connection metadata matches the endpoint
or verified server npub. Workspaces merge only by their real workspace id plus
owner and service identities. Provider change/revocation removes the disclosed
browser projection without deleting or disconnecting an independently verified
configured NStack.

## NIP-78 records

All current-state recovery records are NIP-78 addressable events (`kind:30078`).
The sole public tag is `d`. Its deterministic convention is:

```text
ambulando:nstack:v1:sha256("ambulando.nstack-recovery:v1:<type>:<logical-key>")
```

The hash prevents an opaque stack ID from leaking through the public address.
`host_hint` and `recovery_index` use logical key `current`; per-stack records use
the origin-scoped stack ID as the logical key. The encrypted JSON envelope has
`schema`, `version`, `type`, `deleted`, and `data` fields. Supported types are:

- `host_hint`: host NStack HTTPS endpoint, opaque stack ID and recovery relays;
- `recovery_index`: descriptor/catalogue/policy addresses and snapshot refs;
- `nstack_descriptor`: endpoint, service pubkeys, protocol versions and label;
- `workspace_catalogue`: opaque workspace IDs and labels for one stack;
- `backup_manifest`: blob location, SHA-256, size, bulk algorithm and wrapped
  random data key;
- `policy_intent`: requested stack/workspace capabilities only, never authority.

Content is encrypted with NIP-44 v2 to the current user's own public key through
the active signer, then the outer event is signed normally. Restore verifies the
event signature and author before asking the signer to decrypt. Of events at one
address, the newest valid event wins; malformed newer events do not hide an older
valid replacement. A logical deletion is a newer encrypted tombstone. A kind-5
NIP-09 request may be built and sent separately as best-effort relay cleanup,
but is not the source of deletion truth. Callers must publish the signed
encrypted tombstone successfully before constructing that cleanup request.

The current Settings action publishes the selected host NStack after its
workspace has been freshly verified by Tower. It does not invent endpoints for other
discovered stacks: their descriptors can be added only after a future explicit
per-stack approval workflow supplies connection metadata.

Bootstrap first reads the fixed host-hint address from configured public relays,
then uses its encrypted recovery relays to load the index and referenced records.
Partial stack failures are reported and skipped; they never cause a silent
destination switch. NIP-65 relay metadata may inform a future provider's relay
choice, but it does not make public relays an authority service.

NIP-44 is not blob storage. `UnavailableNStackBlobAdapter` makes the current bulk
I/O limitation explicit while the manifest/key-envelope contract remains usable
and testable. No public upload service is inferred. Recovery assumes continued
control of the same Nostr identity; it restores configuration, not a lost Nostr
private key, and private keys are never included.
