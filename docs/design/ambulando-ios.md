# Ambulando on iPhone

Ambulando's iPhone application embeds this repository's built product UI in
the shared WMapp Flutter/WebView shell. It retains the Ambulando v5 design,
Confluence assets, Alpine components, Dexie storage and TowerSyncService.
The native shell owns WebKit, secure signing, platform permissions and the
existing universal FIPS transport. This is a native application containing
the web UI; it is not a SwiftUI reimplementation.

Native implementation and build procedures belong in WMapp. Its dedicated
Ambulando product configuration must package the validated Sol build, rather
than downloading or silently replacing it with the default Flight Deck UI.
Keep the default browser product and its update channel independent.

## State and identity

A separate app installation and fixed local origin give Ambulando its own
browser storage. Safari, another browser application and the native app do
not automatically share Dexie data, sessions, device identities or permission
grants. Onboarding must use the existing native signer and authorized Tower
identity/grant flow. Never copy private keys or silently assume another app's
workspace access. Preserve the origin across application updates so local
drafts and pending writes remain recoverable.

The WebView continues to render persisted collections through Dexie and
liveQuery. TowerSyncService remains the sole owner of workspace hydration,
SSE, cursor recovery and fallback polling. Native lifecycle integration should
notify existing browser recovery hooks, rather than introducing another sync
engine or changing record contracts.

## Background operation

iOS controls application and WebKit suspension. Foreground JavaScript timers,
SSE connections and uploads are not a promise of continuous locked-screen
execution. Local drafts and queued writes remain local until the application
can resume and complete its normal authenticated recovery.

Suspension must revoke the browser document's transport/signing capabilities,
cancel active streams and reject stale callbacks. Resume establishes fresh
native-validated capability state and notifies the existing foreground recovery
hooks. No fake audio/location background mode is appropriate for keeping the
workspace alive. Push notifications, scheduled background refresh and native
background upload are separate features; packaging the UI does not implement
them.

The consented iOS FIPS packet-tunnel extension has an independent OS lifecycle.
Its continued operation does not mean the WebView continues synchronizing.
Users control VPN consent and stopping the tunnel through the supported native
settings. VPN availability alone does not prove authenticated service access.

## Connectivity boundary

Ordinary HTTPS uses normal platform networking. Approved local/HTTPS pages
reach selected FIPS services only through `window.fipsTransport`. Preserve
top-level-origin consent, exact endpoint/peer/port pinning, cancellation and
document/identity/lock lifecycle revocation. Transport does not authenticate:
NIP-98 signatures remain fresh for the exact URL, method and body above it.
Do not add a Tower-, Autopilot-, upload- or SSE-specific native network bridge,
or fall back to public HTTPS for a selected FIPS service.

## Delivery evidence

A release handoff should identify the Sol source commit and build number,
native source commit, app version/build and bundle identifier. Verify the
packaged `version.json` and assets against the validated Sol output. Keep
generated `dist/`, signed binaries, device records, screenshots and run-specific
logs out of source control.

Simulator compilation and launch establish only simulator behavior. Signed
device delivery additionally needs capability-enabled provisioning for both
the application and packet extension, an authorized reachable device,
successful installation and launch, and explicit physical-device checks.
Record brand/navigation, safe areas/keyboard, HTTPS, offline/reconnect,
background/resume and authenticated FIPS results separately. When pairing,
signing, VPN consent or identity authorization blocks a check, report the exact
missing step and retain the ready build without claiming installation or live
connectivity.

Apple's [packet tunnel provider documentation](https://developer.apple.com/documentation/networkextension/nepackettunnelprovider)
requires the Network Extensions entitlement on the App ID. Its
[capability configuration guide](https://developer.apple.com/documentation/xcode/adding-capabilities-to-your-app)
describes account/team setup and provisioning. The
[Background Tasks framework](https://developer.apple.com/documentation/backgroundtasks)
is the supported boundary for separately implemented background jobs; it is
not enabled merely by embedding a WebView.

## Browser signer recovery

The WM browser's exact `Signer document revoked.` rejection means its injected
NIP-07 document capability was invalidated. It is distinct from a Tower response
revoking server signer authorization. Ambulando remembers the rejected native
provider for that page lifetime, rejects queued and late results belonging to
old providers, and pauses workspace pulls until the host replaces `window.nostr`.
The stored session, cached rows, outbox and download checkpoint remain intact.
Native public-key lookup is bounded; rejection across the sync worker bridge
must settle the caller and preserve the recovery error code.

Only the native host can restore capability: validate the live top-level origin,
identity and document epoch, install a fresh provider, then signal foreground
recovery (currently `focus`). A focus event alone does not revive the old
provider. If native reinjection fails or WebKit terminates, foreground the browser
and reload the page using the same origin; do not clear site data or log out as
recovery. A real Tower authorization rejection remains an authorization failure.
A fresh provider still undergoes the existing session-public-key comparisons.

Browser regression tests establish provider replacement, stale callback rejection
and worker error settlement. Device acceptance separately requires background /
resume and signing in WMapp, including failed reinjection, account changes and
concurrent requests from tabs. Worker requests use the main page's signer queue;
iframes must obtain their own host-authorized capability and cannot revive or
borrow the top-level document's token.
