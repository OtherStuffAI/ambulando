# Kind 33356 Flight Deck Workspace Self-Index

Status: implemented cross-app reader
Last updated: 2026-11-12

## Purpose

Kind `33356` is the user's encrypted, self-published workspace index.

It exists so Flight Deck PG workspaces follow a user across devices. After a
user has connected to a Tower workspace once, they should not need to repeatedly
paste Tower URLs, generate connection tokens, or manually re-enter descriptors on
new browsers, phones, or app installs.

The user's Nostr identity gives us a user-owned discovery mailbox: encrypted
Nostr events addressed to their own npub.

## Relationship To Kind 33357

This document does not change the kind `33357` onboarding contract.

Use:

- `33356` for "I have already verified this workspace; remember it for me."
- `33357` for "someone else added this recipient; they should verify/import."

The existing `docs/33357-onboard.md` format remains the source of truth for
`33357` while Autopilot and other sessions implement that flow.

After a recipient verifies a `33357` onboarding notice, their client may publish
its own `33356` self-index event for future cross-device discovery.

## Authority Model

Nostr discovers possible workspaces. Tower decides current access.

A `33356` event is never an access grant. Clients must verify every decrypted
locator with Tower before showing it as an available workspace.

If a `33356` locator still exists on relays after Tower access is revoked, Tower
`/me` verification rejects it and the app marks it stale or hides it.

## Event Shape

Kind `33356` should be a parameterized replaceable event. Publish one event per
workspace so two devices do not overwrite a single shared list.

Cleartext tags should support filtering without leaking workspace names, Tower
URLs, scope names, channel names, or credentials.

```json
{
  "kind": 33356,
  "pubkey": "<user-pubkey-hex>",
  "created_at": 1780710000,
  "tags": [
    ["d", "fd-self:<opaque-workspace-hash>"],
    ["p", "<user-pubkey-hex>"],
    ["app_pub", "<flightdeck-app-pubkey-hex>"],
    ["protocol", "workspace-self-index"],
    ["v", "1"]
  ],
  "content": "<encrypted payload for user pubkey>"
}
```

The `d` tag should be deterministic for the same user/app/Tower/workspace
identity, but opaque.

Suggested hash input:

```text
v1:<user_pubkey_hex>:<app_pubkey_hex>:<tower_service_npub>:<workspace_id>
```

Clients do not need to know `d` in advance. On login they can query by author,
kind and `#p`, without `#app_pub`. Originating app namespaces differ across
Deets, Alexandria, In Dialogue, Shrapnel and other compatible clients; filtering
by the consuming app hides those indexes. Validate the singleton `app_pub` tag
against the decrypted originating app identity and deterministic address locally.
The locator app identity remains separate and is used for Tower membership.

Readers verify signatures locally, reduce to the newest signed event per `d`
(with lowest event ID breaking equal-time ties), and only then decrypt. A newer
unreadable replacement or tombstone never falls back to an older active locator.
Both flat workspace locator identities and nested `workspace.identity` are accepted.
Every candidate requires a fresh authenticated `/me` with matching workspace,
Tower, service, owner and locator-app identities. A failed candidate does not hide
other Towers. Discovery never automatically selects a Tower or workspace.
Verified Towers appear in the existing connection picker; choosing one uses its
full authenticated paginated workspace list, including unindexed workspaces.
Existing local connections and cached content retain their original partitions.
Publication succeeds only after a relay ACK and exact signed-event readback;
otherwise the existing connection remains usable with publication pending.

## Encrypted Payload

The payload is encrypted to the user's own pubkey.

Prefer NIP-44 encryption when available. Fall back to NIP-04 only if required by
the signer/runtime. If self-encryption is not available, keep the workspace in
local settings and show a recoverable "workspace discovery is not backed up to
relays" state.

```json
{
  "type": "flightdeck_workspace_self_index",
  "version": 1,
  "issued_at": "2026-06-07T00:00:00.000Z",
  "updated_at": "2026-06-07T00:00:00.000Z",
  "user_npub": "npub1...",
  "app": {
    "app_npub": "npub1...",
    "app_pubkey": "<flightdeck-app-pubkey-hex>",
    "namespace": "flightdeck_pg"
  },
  "workspace": {
    "type": "wingman_workspace_locator",
    "version": 1,
    "tower_base_url": "https://tower.example.com",
    "tower_service_npub": "npub1...",
    "workspace_id": "uuid",
    "workspace_service_npub": "npub1...",
    "workspace_owner_npub": "npub1...",
    "app_npub": "npub1...",
    "label": "Wingers",
    "description": "Optional user-facing label",
    "capabilities": [
      "pg_scopes",
      "pg_channels",
      "pg_channel_grants",
      "pg_tasks",
      "pg_chat",
      "realtime_events"
    ],
    "links": {
      "descriptor": "/api/v4/flightdeck-pg/workspaces/uuid/descriptor",
      "me": "/api/v4/flightdeck-pg/workspaces/uuid/me",
      "scopes": "/api/v4/flightdeck-pg/workspaces/uuid/scopes",
      "events": "/api/v4/flightdeck-pg/workspaces/uuid/events"
    }
  },
  "verification": {
    "last_verified_at": "2026-06-07T00:00:00.000Z",
    "verified_by": "flightdeck",
    "tower_service_npub": "npub1..."
  },
  "state": {
    "deleted": false
  }
}
```

For PG workspaces, the payload must not contain a bearer token, connection token,
database credential, or workspace secret. It is a credential-free locator that
points the client back to Tower for NIP-98 verification.

## First Connection Flow

When a user manually enters a Tower URL, scans a descriptor, accepts an
onboarding event, or creates a PG workspace:

1. Flight Deck validates the locator shape locally.
2. Flight Deck verifies Tower service metadata.
3. Flight Deck signs NIP-98 requests and calls Tower `/descriptor` and `/me`.
4. If Tower confirms access, Flight Deck stores the locator in local
   `knownWorkspaces`.
5. Flight Deck publishes or refreshes a kind `33356` self-index event for that
   workspace.
6. The workspace becomes available on future devices after Nostr login.

If publish fails, the workspace should still open locally. The UI should show
that cross-device discovery has not been backed up yet.

## Login Discovery Flow

On every login or app startup with a Nostr signer:

1. Resolve the logged-in pubkey.
2. Query configured relays for kind `33356` events:
   - author equals the logged-in pubkey;
   - `#p` equals the logged-in pubkey;
   - `#app_pub` equals the current app pubkey;
   - `#protocol` equals `workspace-self-index`.
3. Decrypt and validate each payload.
4. Deduplicate locators by app, Tower service npub, workspace id, and workspace
   service npub.
5. For each candidate locator, call Tower:
   - `GET /api/v4/flightdeck-pg/workspaces/:workspaceId/descriptor`
   - `GET /api/v4/flightdeck-pg/workspaces/:workspaceId/me`
6. Merge verified workspaces into `knownWorkspaces`.
7. Hide or mark stale locators that Tower rejects.

The app should show a small "Workspace discovered" state when new verified
workspaces appear.

## UI States

Flight Deck should distinguish:

- `Local only`: workspace exists in local settings but has no relay self-index.
- `Indexed`: kind `33356` was published for the workspace.
- `Discovered`: relay event decrypted and parsed.
- `Verified`: Tower confirms current access.
- `Ready`: enough workspace metadata has synced to open.
- `Stale`: event decrypts, but Tower rejects current access.
- `Failed`: decrypt, parse, network, or verification failed.

Normal workspace lists should show `Verified` and `Ready` workspaces. Stale or
failed entries belong in diagnostics/recovery.

## Deletion And Revocation

Revocation:

- Admin removes access in Tower.
- Old `33356` events may remain on relays.
- Future Tower `/me` verification rejects access.
- Client marks the locator stale and hides it from normal workspace switching.

User removes from local list:

- Client removes the workspace from local `knownWorkspaces`.
- Client should publish a replacement `33356` event with the same `d` tag and
  `state.deleted=true`.
- Other devices that decrypt the tombstone should hide that self-index entry.

This does not revoke Tower access. It only removes the user's personal discovery
entry.

## Relay Strategy

First implementation can use:

- app default relays;
- relays configured in Flight Deck settings;
- relays exposed by the signer when available;
- later, the user's NIP-65 relay list.

Publishing is best effort across multiple relays. A locator is considered
published if at least one configured relay accepts it, but partial failures
should be visible in diagnostics.

## Security Rules

- Tower grants access.
- Nostr remembers where to verify access.
- Cleartext tags must not expose workspace names, scope names, channel names,
  URLs, or tokens.
- PG self-index payloads must not contain bearer tokens or database credentials.
- Scope/channel/group/task/doc lists are not part of the payload.
- Revocation is enforced by Tower verification.
- Duplicate payloads are idempotent by app pubkey, Tower service pubkey,
  workspace id, workspace service npub, and user.

## Open Decisions

- Exact app pubkey/namespace for `wm-fd-2` PG mode in cleartext `app_pub`.
- Whether NIP-44 is mandatory for launch, or NIP-44 with NIP-04 fallback.
- Whether deletion tombstones should be automatic when Tower reports revoked
  access, or only when the user explicitly removes the workspace from their
  personal list.

## Implementation Slice

- Add relay query/publish helpers for `33356`.
- After successful PG workspace verification, publish one self-index event.
- On login, query/decrypt `33356`, verify with Tower, and merge into
  `knownWorkspaces`.
- Show local/indexed/discovered/verified states.
- Do not modify the existing `33357` payload shape in this slice.
