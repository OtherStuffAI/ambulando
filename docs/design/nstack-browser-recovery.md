# NStack browser discovery and encrypted recovery v1

Ambulando consumes an injected `window.NStack`; it does not install or emulate a
production provider. `src/nstack-provider.js` is the stable boundary around the
approved v1 methods. Availability reveals only the protocol version. Stack and
workspace lists stay inaccessible until `requestDiscovery()` succeeds. The
adapter accepts only origin-disclosed opaque IDs, requests named capabilities for
one selected destination, keeps capability handles and connection metadata in
memory, and invalidates every handle on the provider's reason-only change event.

The deterministic provider in `tests/fixtures/` is contract evidence, not a
browser global. Nostr Browser can replace that fixture without changing the
manager or Settings UI. The provider must enforce origin consent and return
origin-specific IDs. It must never return administrator credentials, private
keys, signer/bunker/NWC secrets, cookies, database credentials, bearer tokens or
another reusable raw capability token.

The provider surface follows NBrowser v1 exactly: stack summaries are
`{id,name,host,available}`, workspace summaries are `{id,name}`, capability
requests use `capabilities` plus optional `duration`, and approved results contain
`handle`, `expiresAt`, and `connection`. Ambulando asks for `workspace.read` for
15 minutes. `change` carries only `{reason}` and is a prompt to discard handles
and explicitly review/re-list; the event is not authority.

### Separate NBrowser recovery record

NBrowser owns its browser-host bootstrap record: one self-encrypted kind-30078
event with `d=org.wingman.nbrowser.settings.v1` that points to one immutable,
encrypted settings snapshot object. Ambulando neither reads nor writes that
address and never presents its contents as provider records. The richer records
below use a separate Ambulando namespace and remain independently replaceable,
application-owned configuration recovery records.

## Local selection boundary

The selected stack/workspace summary is stored in shared Dexie under an exact
`origin + Nostr identity + local Ambulando workspace` partition. IDs and labels are the only persisted
provider fields. Capability handles are deliberately not persisted. A restored
choice does not become active authority: the user must review the destination
and request a fresh handle. It is never copied into Tower workspace records or
hydrated through `TowerSyncService`.

## Unified setup projection

Settings presents one NStack collection. Every saved/manual Tower or Supabase
server is projected as an NStack immediately, with its saved workspaces nested
beneath it and the active route shown as `NStack → workspace`. The projection
does not rewrite legacy settings or create another transport path.

Consented `window.NStack` results enter that same collection. Pre-approval
browser summaries remain provisional and are never merged by label or opaque
origin-scoped ID. After capability approval, Ambulando may merge the browser
entry with a configured NStack only when normalized connection metadata matches
the endpoint or verified server npub. Provider change/revocation removes that
in-memory approval evidence and capability handle without deleting an
independently configured NStack. Browser workspace IDs are not merged with
saved workspace identities by name.

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
workspace capability has been approved. It does not invent endpoints for other
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
