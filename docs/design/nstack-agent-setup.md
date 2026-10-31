# nStack workspace and agent setup

Start with the existing manual nStack address or consented Nostr Browser
workspace discovery. Nostr Browser's implemented bridge is `window.NStack` v1:
`requestDiscovery({workspaces:true})`, `listNStacks`, `listWorkspaces` and
`getConnection`. The Dart bridge in Nostr Browser is authoritative; older
capability-handle documentation is not the connection API.

Workspace selection uses fresh signed descriptor and membership reads. The exact
workspace UUID resolves its owner and app. The new typed
`GET /api/v4/flightdeck-pg/workspaces/:id/app-registration` checks existing
`workspace.read` authority and returns minimal public registration metadata.
It does not create a namespace or use the legacy workspace ACL. Callers verify
workspace, owner, app and any pinned Tower identity before importing.

There is currently no stable registration product identifier that proves an
arbitrary app namespace is Ambulando. The selected authorized locator supplies
the candidate app identity, registration verifies that exact identity, and the
picker/agent confirmation shows it for user review. This is a user-confirmed
registered app, not automatic identification by display name. Different app
namespaces remain separate workspace choices; no first-match search or fallback
to another app is used.

From Agents, Add agents discovers `/.well-known/nstack.json` at the selected
nStack HTTPS origin. The Tower entry must match that origin. Exactly one
explicitly configured `autopilot` service supplies the HTTPS origin; none is an
actionable configuration error and multiple entries are refused. Tower advertises
this service only when `NSTACK_AUTOPILOT_PUBLIC_ORIGIN` is configured as a safe
root origin. Its health observation is `unknown` until clients check it.

Owner health and agent reads use fresh exact NIP-98 signatures over HTTPS.
Autopilot independently checks owner/delegation scope, resource filters and agent
instruction visibility. Installation ID is checked against its public signing
identity. No package, signature, secret or complete discovery response is stored.
Only selected public connection and agent metadata enter existing Tower commands
and Dexie materialization. Tower's installation/agent keys deduplicate retries.

The Add selected agents over HTTPS action explicitly selects HTTPS for that
installation. Existing signed FIPS metadata is retained when the installation
already exists. A selected FIPS client never falls back to HTTPS, and existing
signed FIPS package setup remains available. HTTPS records carry
`metadata.transport_mode = "https"`; the existing compatibility contract accepts
the HTTPS endpoint in `fips_endpoint` as well as `https_endpoint`. This does not
claim a verified FIPS identity. Reconnect uses the persisted explicit mode.

The native iPhone/Mac app shares the same HTTPS discovery and command flow in
`NStackAgentSetup` and its Agents sheet. It uses the selected workspace's app
identity and confirms it visibly. Native still refuses FIPS; no native FIPS
implementation is included. Android is deferred.

Activation requires updated Tower source and the explicit Autopilot origin
configuration, updated Autopilot owner-read routes, and updated clients. Backend
source tests do not activate running services. Autopilot restart requires separate
operator approval. After activation, check registration as a typed-only member,
HTTPS discovery with FIPS unavailable, selected-agent add/retry/reload, and real
browser-provider consent/revocation. Fixture agents do not establish a real Kato
connection. Setup sends no instructions or messages to agents.
