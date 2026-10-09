<p align="center">
  <img src="public/ambulando/confluence-approved.png" alt="Ambulando logo — Solvitur Ambulando" width="480">
</p>

# Ambulando

**Solvitur Ambulando** — “It is solved by walking.”

The Latin phrase expresses a practical idea: taking a step helps you find the
way forward. Ambulando applies that idea to collaborative work. Start a
conversation, turn an intention into a task, bring in the right context, and
review the result. Each action produces evidence that makes the next decision
clearer.

Ambulando is the browser workspace for coordinating people and AI agents in
Wingman Be Free. It brings conversations, work, knowledge, and agent activity
together so you can direct progress and review what gets done. This repository
contains the Flight Deck web client, presented with the Ambulando design system.

## What you can do

- **Chat in context.** Use channels and threads to discuss work, share
  attachments, mention people or agents, and follow working updates. Inbox
  brings attention back to conversations that need you.
- **Track tasks.** Organize work in lists and boards, assign responsibility,
  track state, dates and dependencies, and keep descriptions and comments with
  the task.
- **Write and connect documents.** Create and edit rich documents, organize
  wiki navigation, follow internal links and backlinks, and discuss the content
  in comments.
- **Share files.** Upload workspace files, preview images and attachments, and
  download them through authenticated storage access.
- **Explore project context.** Use the scope context tree in outline or visual
  form to find connected tasks, documents, files and artifacts. Structure and
  reference editing follow workspace permissions.
- **Coordinate agents.** Connect to Autopilot agents, direct work from
  conversations, and inspect current activity and retained working history.
  Toolbox connects the workspace to WApps.

Workspaces, scopes and channels keep related work together. Responsive layouts,
light and dark themes, and browser-local data support everyday use on desktop
and phone. Available actions and records depend on workspace permissions and
connected services.

## How the system fits together

| Component | Responsibility |
| --- | --- |
| **Ambulando / Flight Deck** | Browser experience, local Dexie data, workspace navigation, and coordination UI. |
| **Tower** | Shared workspace records, authentication, typed APIs, storage, and access authority. |
| **Autopilot** | Agent execution, sessions, pipelines, triggers, managed apps, and runtime lifecycle. |

The browser reads and writes shared state through Tower. Autopilot supplies the
agent and app runtimes exposed through the workspace. Alpine drives the UI;
Dexie materializes workspace records locally, while background synchronization
and server-sent events keep them current. Local changes can appear before their
Tower writes finish; sync status communicates pending or failed work.

See the [presentation and integration guide](docs/design/ambulando-sol.md),
[context browser](docs/design/context-tree-browser.md), and
[checkout semantics](docs/checkout_semantics.md) for implementation details.
The [artwork and icon provenance](public/ambulando/README.md) records the existing
brand assets and their separate licensing terms.

## Contributing

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

Backend deployment guidance is in [Tower backend operations](docs/tower-backend-prod.md).

The [Postgres migration guide](docs/pg-migration/implementation.md) describes the backend transition.

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
workspace-specific paths, or backend-driven UI states are dead. See the
[unused-code report guide](docs/unused-code-report.md) for the current baseline
and cleanup guidance.

For application source changes, run the complete validation gate:

```bash
bun run validate
```

`validate` composes lint, public-source checks, Vitest, build, dist asset
verification, and `git diff --check`. The build step uses the normal local
Flight Deck build behavior, so release build metadata may change and should be
committed when appropriate. For documentation-only changes, verify links and
rendering, run `bun run check:public-source`, `bun run test` and
`git diff --check`, and avoid
`validate` or a build that would change release metadata.

Build the static site with:

```bash
bun run build
```

Generated `dist/` output is ignored and rebuilt for deployment. Before
publishing the source or creating a replacement repository, follow the
[public-source policy and clean-history procedure](docs/public-source-policy.md).

## Further reading

- [Release notes workflow](docs/release-notes.md)
- [Context editing and authority](docs/design/context-tree-editing.md)
- [File previews and storage routing](docs/design/file-previews.md)
- [Subscribed feed reader](docs/design/wapp-feed-reader-proposed.md): source
  implementation, selected Tower/WApp adapters, and remaining integration
  boundaries. Legacy Feed publishing remains available; source validation does
  not establish live activation.
