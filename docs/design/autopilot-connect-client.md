# Autopilot Connect client seam

Flight Deck accepts versioned `wingman_autopilot_connect` v1 and v2 envelopes with
two fields: `manifest` and `signature`. The signature is a valid Nostr event of
kind `27236`; its content is the manifest encoded with recursively sorted object
keys. The event signer must equal `manifest.installation.npub`, and the exact
FIPS origin must match the identity required by that version.

Version 1 retains its original invariant: signer, installation identity and
FIPS host identity are the same. Version 2 separates the stable installation
signer from `transport.fips.npub`; the event is still verified against
`installation.npub`, while the endpoint must be exactly
`http://<transport.fips.npub>.fips:<port>`. Native pairing pins that endpoint
and its `transport.fips.npub`; the later authenticated control health request
independently verifies `installation.npub`. Generation time
is signature-bound and valid for five minutes, with a
15-second future clock allowance.

The signed manifest advertises `api.version` (currently `1`), `health_path`,
`agents_path`, and read capabilities. Its optional HTTPS endpoint is descriptive
metadata only. The client always connects and fetches through WMapp's universal
`window.fipsTransport` v2 provider. It calls
`connect({ endpoint, peerNpub: transportNpub, purpose:'autopilot' })`, retains and
verifies the returned scoped handle, signs and sends the same exact mesh URL and
method with NIP-98, rejects redirects, and never retries through HTTPS.

Agent Space reads, including pipeline views, and live thread activity use the
same retained Autopilot handle. Live event responses remain streaming Responses,
so existing abort, incremental SSE parsing, cursor and reconnect behavior stays
above transport. Disconnecting a client revokes only its selected handle; Tower,
Drive, and other Autopilot handles remain active.

Health must return `ok`, `installation_id`, `installation_npub`, and
`api_version`. Discovery must return the matching `installation_id` and an
`agents` array. Flight Deck exposes only normalized `agent_id`, `bot_npub`,
`name`, `description`, and `can_instruct` fields; it neither persists nor renders
the raw response. Discovery also retains only the four signed per-agent paths;
Agent Space never synthesizes paths or falls back to HTTPS.

Packages containing credential-like fields or secret URI/key prefixes are
rejected before verification. The client does not log packages, authorization
headers, response bodies, or native bridge capabilities.

Autopilot clients in the same native transport provider share one scoped handle
for an identical endpoint, peer identity and purpose. Each client owns a lease;
concurrent initial requests connect once, and only the final release disconnects
the native handle. A client cancelled while connecting releases its pending
lease without revoking another consumer. Agent Space discovery, read and restart
status clients release their leases in `finally`, including errors and retries.
This prevents overlapping capability refresh and overview reads from creating
ambiguous native signing grants without broadening endpoint consent.
