# Hosted signup broker integration

Ambulando's server uses Autopilot's dedicated hosted-site grant. It does not load
a raw site signing key. `FLIGHT_DECK_SITE_NSEC` no longer activates startup.
The browser sends its own exact NIP-98 user proof; the server verifies it and
passes the exact UTF-8 payload and event to the broker. Signed site responses
are independently verified before forwarding to Tower.

After the reviewed Autopilot source is activated, the real managed-app owner
opens Autopilot **Secrets**, selects/imports the existing site custody record,
and uses **Authorize hosted signup**. Review these public bindings:

- Registered Ambulando Sol app ID from the managed app inventory.
- Site identity: `npub1hd37reqgfcnz3pvzj4grknd2nkzc94p9ercmunrxx22razr2rfxsw6dns5`.
- Exact endpoint: the explicitly approved hosted Tower URL ending in `/api/v4/flightdeck-pg/hosted/workspaces`.
- Select the actual imported record and revision; use a reviewed expiry, such as 30 days.

Autopilot privately captures an opaque capability file and shows only its path.
Configure the managed app environment through Autopilot app settings:

```text
FLIGHT_DECK_TOWER_PUBLIC_BASE_URL=https://hosted.example/
FLIGHT_DECK_SITE_BROKER_URL=http://127.0.0.1:<actual-autopilot-listener-port>/
FLIGHT_DECK_SITE_CREDENTIAL_FILE=<server-captured-private-capability-file>
```

`APP_ID` comes from the managed runner; do not override it. Keep the capability
file outside `dist/` and other public roots. The adapter requires an absolute,
owner-only, regular, single-link file and rejects symlinks and raw nsecs. It
only contacts a numeric loopback HTTP broker, with no redirect or remote fallback.

`/healthz` and `/api/hosted/config` check live broker custody, app identity,
target and grant expiry. They also make an unsigned invalid-body POST to the
exact hosted endpoint and require its `401 nip98_auth_required` JSON response.
This request cannot provision a workspace. A missing route, expired/revoked
grant, credential-file error or unavailable broker keeps signup unavailable.
No credentials or internal paths are returned by these public endpoints.

The route probe does not prove Tower site allowlisting or successful billing.
After the Tower owner verifies the exact site allowlist and the app is activated
through Autopilot's managed runner, perform one labeled signup using an actual
direct-user browser signer. Retry with fresh proofs and the same payload and
idempotency key. Report the workspace, welcome credit, ledger and billing account
linkage without deleting test records. Stripe stays in test mode and legal pages
stay drafts. Do not restart Autopilot as part of an app build/restart.
