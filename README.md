# Ambulando Sol

Sol is the connected Flight Deck frontend with Ambulando design system v5.
It retains the Alpine/Dexie/Nostr/Tower application and record contracts.
See [the surface map and integration conventions](docs/design/ambulando-sol.md)
and [local identity/icon provenance](public/ambulando/README.md).

This fork keeps source commits local until a dedicated remote is configured.
Do not push Sol changes to the original Flight Deck upstream. Build outputs are
ignored; existing live application registrations are independent of this fork.

# Flight Deck application foundation

Flight Deck is the human coordination workspace for Wingman Be Free. It gives people one browser interface for conversations, tasks, documents, scopes, flows, approvals, colleagues, and WApps—so they can direct work, see what is happening, and review what agents produce.

Flight Deck is one of three distinct parts of the core system:

- **Flight Deck coordinates the people and work.** It owns the human-facing workspace experience and its local Dexie materialization.
- **Tower holds the shared truth.** It owns authentication, workspaces, typed APIs, storage, and graph access boundaries.
- **Autopilot runs the work.** It owns agents, sessions, pipelines, triggers, managed apps, and their runtime lifecycle.

Flight Deck reads and writes shared workspace state through Tower, while Autopilot supplies the agent and app runtimes that users can direct from the interface. Flight Deck does not become the backend or the agent supervisor: its job is to make coordination clear, fast, and useful to humans.

This repository is the active Flight Deck web client. It preserves responsive, local-first ergonomics by materializing Tower Postgres records in Dexie, while typed Tower adapters and an SSE-first sync path keep the shared workspace current.

## Development Model

Run model:

- Dev: run locally via Wingman/PM2
- Prod: publish the built static site for the live deployment
- Do not use Docker for local Flight Deck development
- Wingman app-card runtime is owned by Autopilot app registry; do not commit generated `ecosystem.config.cjs` files

App namespace:

- The frontend app namespace comes from `FLIGHT_DECK_PG_APP_NPUB`
- Flight Deck refuses to build if that env is unset or is not an `npub`.

Schema workflow:

- Published record-family manifests live in `../sb-publisher/schemas/flightdeck`
- `bun run test` validates real Flight Deck outbound payloads against those published schemas
- If a record payload changes, update the schema manifests and republish them with `sb-publisher`

Backend deployment note:
- `docs/tower-backend-prod.md` covers the Tower env, Docker commands, and admin connection-token flow from the Flight Deck side

Migration planning starts in `docs/pg-migration/implementation.md`.

Install dependencies and run the test suite with:

```bash
bun install
bun run test
```

Run the first-pass source quality gate with:

```bash
bun run lint
```

`lint` uses Biome for fast parser and baseline recommended-rule coverage across
Flight Deck source, scripts, tests, JSON, and CSS while preserving the existing
formatting baseline. `bun run lint:fix` applies safe Biome fixes without
reformatting the repository; `bun run format` is available for explicit
developer formatting work.

Run the report-first unused-code check with either command:

```bash
bun run unused
bun run unused:report
```

The unused-code report uses Knip and exits zero even when it finds baseline
issues. Treat it as evidence for task handoffs, not as delete permission. Knip
reports static unused files, dependencies, exports, duplicate exports, and
unlisted imports; it does not prove that runtime branches, feature-flag paths,
workspace-specific paths, or backend-driven UI states are dead. See
`docs/unused-code-report.md` for the current baseline and cleanup guidance.

Before committing a source checkpoint, run:

```bash
bun run validate
```

`validate` composes lint, public-source checks, Vitest, build, dist asset
verification, and `git diff --check`. The build step uses the normal local
Flight Deck build behavior, so release build metadata may change and should be
committed when appropriate.

Build the static site with:

```bash
bun run build
```

Generated `dist/` output is ignored and rebuilt for deployment. Before
publishing the source or creating a replacement repository, follow the
sanitization and clean-history procedure in `docs/public-source-policy.md`.

## Subscribed feed reader

[Subscribed feed reader](docs/design/wapp-feed-reader-proposed.md) documents the
source implementation, selected Tower/WApp adapters and remaining integration
boundaries. Legacy Feed publishing remains available. Source builds and tests
are not a claim of integrated release or live activation.
