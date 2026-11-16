# Shared NStack workspace QR

Paste `nstack:workspace:v3:…` in Connect → manual connection, or choose a QR image.
Image scanning uses the browser's BarcodeDetector API; where unavailable, paste
identical copied connection text. Camera capture is not implemented. Verify the
preview's name, exact workspace UUID, service/authority keys and endpoint against
the source you trust, select the offered transport, then confirm.

The parser accepts at most 8192 UTF-8 bytes, canonical unpadded base64url and compact
JSON with exactly the contract's keys. It verifies the service's kind-30383 Nostr
signature locally. Confirmation generates a fresh 32-byte nonce and makes one
user-authenticated GET to the selected endpoint's exact workspace connection-proof
route. Kind-30384 signature, nonce, exact signed URL, UUID, authority and 60-second
expiry must match. Denial or mismatch cannot create a workspace, register an app,
grant access or substitute a workspace. Existing Tower/workspace pins prevail.
Existing namespace registration and app-specific membership verification run before
remembering and selecting the exact workspace. Legacy input paths are unchanged.

HTTPS uses the advertised origin. FIPS uses the exact advertised checksummed
`peer_npub.fips:port` through the existing endpoint-scoped `window.fipsTransport`
v2 handle. It requires a compatible native shell; ordinary browsers cannot supply
that capability. A health response is only an early diagnostic; the authenticated
proof remains mandatory. No selected FIPS failure retries HTTPS. Transport choice
is explicit, and no new bridge or machine identity is created.

Verification: parser/proof tests, connection orchestration tests (preview without
network, exact selection, denial, pin mismatch and missing FIPS), and existing
transport tests. Real camera/image acceptance and real-account HTTPS/FIPS acceptance
remain separate from synthetic tests and builds.

The signed fixture generator in `scripts/workspace-connection-fixture.mjs` uses a
well-known synthetic key with no authority. Its bytes are shared by Android and
Swift core tests, including signed invalid shapes and proof mismatches.
