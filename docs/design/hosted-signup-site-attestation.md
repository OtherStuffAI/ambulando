# Hosted signup site attestation

Tower's contract is `tower/docs/hosted-flightdeck-pg-signup.md` at commit `64dfd2c`. The Wingman Suite Architecture board's latest saved scene is `Wingman_Suite/wingman-suite-arch/v7`; Flight Deck owns the site endpoint, Tower owns signup authority, and Autopilot owns the managed app process.

## Runtime route

`bun run start` now runs `server/start.js` on `PORT` (default 8093). It serves the built `dist/` tree and handles `POST /api/hosted/workspaces` on the same HTTPS origin as the browser. `GET /healthz` reports `signup_ready` and the nonsecret site npub. The route is deliberately unavailable with HTTP 503 if its runtime configuration is absent. Browser UI is a separate stage.

The browser must sign `POST <FLIGHT_DECK_TOWER_PUBLIC_BASE_URL>/api/v4/flightdeck-pg/hosted/workspaces`, including the exact UTF-8 JSON bytes it sends to the site route. It sends the user event in `Authorization: Nostr <base64-json>`. The server accepts only this route and the three-field signup JSON, validates the direct user event and payload hash, and signs the same target, method and body hash with a `user_event_id` tag. The server forwards the unchanged body and authorization to the fixed Tower URL. A retry keeps body bytes and idempotency key but generates fresh user and site events.

## Managed configuration and activation

The Autopilot app registry's `WM Flight Deck` entry for this checkout already invokes `bun run start` on port 41045. Its managed runtime needs these names (values are private operational configuration):

| Name | Meaning |
| --- | --- |
| `FLIGHT_DECK_SITE_NSEC` | Runtime-only site signing identity. Never use a `VITE_` prefix or inject it at build time. |
| `FLIGHT_DECK_SITE_ORIGIN` | Exact public HTTPS browser origin, such as `https://flightdeck.example.com`. |
| `FLIGHT_DECK_TOWER_PUBLIC_BASE_URL` | Tower's exact public HTTPS origin with trailing `/`; the same origin Tower sees through trusted proxy headers. |
| `PORT` | Managed app listener port, already supplied by the app runtime. |

At startup the server derives the signer npub in memory and compares it to `npub1hd37reqgfcnz3pvzj4grknd2nkzc94p9ercmunrxx22razr2rfxsw6dns5`. A missing or mismatched signer prevents signup readiness. The `/healthz` public result exposes only readiness and this npub; it does not sign. The app's public URL must route `/api/hosted/workspaces`, `/api/hosted/config`, and `/healthz` to this Bun process, with no static CDN interception or cached POST response. The config route exposes only signup readiness and the public Tower base URL so the browser can sign the exact URL Tower will receive. The operator should inspect the managed app command and configuration **names** at the deployed Flight Deck origin, provision any missing names through its secret manager, build from the reviewed source commit, and deploy/restart that app only during the coordinated activation. No Tower or Autopilot restart is part of this change. Tower must separately allowlist the same public npub through `FLIGHT_DECK_HOSTED_SIGNUP_SITE_NPUBS`.

For rotation, provision the next server signing identity and include both public npubs in Tower's allowlist for at least 60 seconds. Update the expected site npub in this reviewed source, deploy the new app configuration, verify `/healthz`, then remove the old npub from Tower after old events expire. Never print or copy private-key values in diagnostics, logs, docs, build output, or task comments.

## Live acceptance

After activation, verify HTTPS `GET /healthz` returns `signup_ready: true` and the expected public npub. Use a browser with a direct user signer to submit one valid signup through the deployed site origin, then retry the same body/idempotency key with new events and check Tower returns `200` with `replayed:true`. Confirm forged and expired proofs fail and that the browser build contains no server-only module. Until this signed browser end-to-end check succeeds, live signup is unverified.
