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

From Agents, Add agents first reads the selected workspace's existing typed
`autopilot-connections` with fresh `workspace.read` authorization and the exact
app identity. A single stored connection supplies its `https_endpoint`; multiple
installations require an explicit selection. Archived and cross-workspace rows
are refused. Stored installation ID and public identity (when present) must match
fresh health. A stored record is a discovery input, not a health assertion.

For a first connection, enter the Autopilot root HTTPS address in setup. It is
verified before agent selection and saved through the existing typed commands
only when the user adds agents. An address matching a stored connection retains
its identity pins. No Tower environment change is required. A selected connection
without HTTPS requires explicit address entry; selected FIPS never silently
falls back. This setup action explicitly chooses HTTPS for the agents being added.

Only when there is no stored or explicit target may `/.well-known/nstack.json`
supply an optional `autopilot` hint. Missing advertisement prompts for the address;
multiple hints require explicit input. Optional advertisement is never required
for stored/manual targets, and is never retried as a fallback after denied or
unavailable health/agent reads. The descriptor's Tower entry must match the
selected origin when the descriptor is used.

AP-to-workspace onboarding stores a Tower backend connection/subscription,
workspace/app identity and workspace-key registration. That direction does not
automatically publish the reverse typed `autopilot_connection` record or an
Autopilot public HTTPS origin into the workspace. Older flat launcher settings
may contain URLs (and local compatibility cards), but do not prove an installation
identity. They are not silently promoted to typed connections by this flow.
Existing typed connections avoid repeated address entry; when none exists, the
address must be supplied once here (or by optional advertisement). Setup does not
create an app registration, alter delegation, or auto-register every agent.

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

Running services still need to support the exact typed app-registration route
and authorized owner HTTPS health/agent reads. That is a service-version and
permission requirement, never a Tower environment prerequisite. Backend source
tests do not activate running services. Autopilot restart requires separate
operator approval. Check registration as a typed-only member, HTTPS discovery
with FIPS unavailable, stored connection with no descriptor AP entry, first-time
address, selected-agent add/retry/reload, denied/ambiguous/unavailable states, and
real browser-provider consent/revocation. Fixture agents do not establish a live
connection. Setup sends no instructions or messages to agents.
