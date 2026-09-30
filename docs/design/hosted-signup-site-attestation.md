# Hosted signup site attestation

Tower's contract is `tower/docs/hosted-flightdeck-pg-signup.md` at commit `64dfd2c`. The Wingman Suite Architecture board's latest saved scene is `Wingman_Suite/wingman-suite-arch/v7`; Flight Deck owns the site endpoint, Tower owns signup authority, and Autopilot owns the managed app process.

## Runtime route

`bun run start` runs `server/start.js` on `PORT` (default 8093). The public CapRover image sets `PORT=80` and runs this same command as its sole process. It builds the committed `.build-meta.json` version through `scripts/build-caprover.mjs` so the image and release notes keep the same build number. The image contains production Bun dependencies, `server/`, and the built `dist/` tree; only `dist/` is served as browser assets. The server handles `POST /api/hosted/workspaces` on the browser origin. `GET /healthz` reports `signup_ready` and the nonsecret site npub. Missing or invalid runtime configuration keeps the UI available while signup and its public config report unready.

The browser must sign `POST <FLIGHT_DECK_TOWER_PUBLIC_BASE_URL>/api/v4/flightdeck-pg/hosted/workspaces`, including the exact UTF-8 JSON bytes it sends to the site route. It sends the user event in `Authorization: Nostr <base64-json>`. The server accepts only this route and the three-field signup JSON, validates the direct user event and payload hash, and signs the same target, method and body hash with a `user_event_id` tag. The server forwards the unchanged body and authorization to the fixed Tower URL. A retry keeps body bytes and idempotency key but generates fresh user and site events.

## Managed configuration and activation

The local Autopilot app registry's Flight Deck entry invokes `bun run start` on port 41045. The local browser may use HTTP; Tower still uses an HTTPS URL and verifies both signatures. The public Flight Deck origin uses a separate CapRover image from `captain-definition`; its container listens on port 80. The public CapRover app needs these runtime names (values are private operational configuration):

The repository does not expose the public CapRover app's runtime variable names, so provisioning of these exact names remains an activation check. A site identity configured for a different app or under a different name does not make this image signup-ready.

| Name | Meaning |
| --- | --- |
| `FLIGHT_DECK_SITE_NSEC` | Runtime-only site signing identity. Never use a `VITE_` prefix or inject it at build time. |
| `FLIGHT_DECK_TOWER_PUBLIC_BASE_URL` | Tower's exact public HTTPS origin with trailing `/`; the same origin Tower sees through trusted proxy headers. |
| `PORT` | CapRover container listener is 80. The local Autopilot app supplies its own port. |

At startup the server derives the signer npub in memory and compares it to `npub1hd37reqgfcnz3pvzj4grknd2nkzc94p9ercmunrxx22razr2rfxsw6dns5`. A missing or mismatched signer prevents signup readiness. The `/healthz` public result exposes only readiness and this npub; it does not sign. The app's public URL must route `/api/hosted/workspaces`, `/api/hosted/config`, and `/healthz` to this Bun process, with no static CDN interception or cached POST response. The config route exposes only signup readiness and the public Tower base URL so the browser can sign the exact URL Tower will receive. The request's browser Origin or Host is not used as signing authority; the server requires a valid direct user proof for the fixed Tower URL before adding its site attestation. Static responses retain immutable `/assets/` caching, index revalidation, no-store `version.json`, and service-worker revalidation. The operator should inspect the CapRover app's runtime configuration **names**, provision missing names through its secret manager, build from the reviewed source commit, and deploy the public app only during coordinated activation. The local Autopilot app is a separate deployment. No Tower or Autopilot restart is part of this change. Tower must separately allowlist the same public npub through `FLIGHT_DECK_HOSTED_SIGNUP_SITE_NPUBS`.

For rotation, provision the next server signing identity and include both public npubs in Tower's allowlist for at least 60 seconds. Update the expected site npub in this reviewed source, deploy the new app configuration, verify `/healthz`, then remove the old npub from Tower after old events expire. Never print or copy private-key values in diagnostics, logs, docs, build output, or task comments.

## Live acceptance

After activation, verify HTTPS `GET /healthz` returns `signup_ready: true` and the expected public npub. Use a browser with a direct user signer to submit one valid signup through the deployed site origin, then retry the same body/idempotency key with new events and check Tower returns `200` with `replayed:true`. Confirm forged and expired proofs fail and that the browser build contains no server-only module. Until this signed browser end-to-end check succeeds, live signup is unverified.
