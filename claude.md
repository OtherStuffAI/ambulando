# Flight Deck Agent Guide

Keep `agents.md` and `claude.md` identical.

## Repository scope

Flight Deck is the browser client for Wingman Be Free. It owns browser UX,
Dexie-backed local state, Tower transport adapters, record translators,
background sync, workspace switching, and browser-side onboarding. Tower owns
authority semantics and its database; Autopilot owns agent/runtime lifecycle.

Before changing behavior, read the relevant material in `docs/`. Start with
`README.md`, `docs/checkout_semantics.md`, and the applicable files under
`docs/design/`. Important implementation seams are:

- `src/app.js`: main Alpine state and user-facing orchestration
- `src/db.js`: Dexie schema and persistence
- `src/api.js`: signed Tower requests
- `src/workspaces.js`: workspace normalization
- `src/worker/`: background materialization, flush, pull, and SSE behavior
- `src/translators/`: family-specific local and outbound mappings
- `src/sync-families.js`: sync-family registration
- `tests/`: unit, integration, and browser coverage

## Design rules

- Render persisted collections from Dexie, preferably with `liveQuery`.
- Keep transport, local-row, and rendered-UI shapes separate.
- Keep heavy sync, crypto, migration, and reconciliation work off the main thread.
- Make workspace-aware asset lookup backend-aware.
- Preserve good partial workspace metadata when remote payloads are sparse.
- Keep shared record-family payloads compatible with Tower, Yoke, and published
  schemas; coordinate contract changes across the owning repositories.
- Preserve scroll position when live chat or thread data changes unless the user
  explicitly requests a jump to the latest item.

## Build and release

This is a Vite project. Edit root `index.html` and source files, never generated
`dist/index.html`. The build creates `dist/` for local runtime and deployment;
generated `dist/` output is ignored and must not be committed.

After source changes:

1. Run focused tests, then `bun run test` when practical.
2. Run `bun run check:public-source`.
3. Follow `docs/release-notes.md`: use the next `.build-meta.json`
   `absoluteVersion`, add a matching `release-notes.json` entry (or an explicit
   no-user-visible-change entry), and run the release-note tests.
4. Run `bun run build` and confirm `dist/version.json` contains the final build.
5. Run `bun run verify:dist` and `git diff --check`, then commit source and build
   metadata without generated `dist/` output.

Use the repository's configured Wingman development runtime. Do not start a
standalone preview, deploy, or modify adjacent services unless the user asks.

After UI changes, run the scriptable, agent-independent Playwright performance
baseline:

```bash
PLAYWRIGHT_DISABLE_VIDEO=1 bun run test:e2e:perf
```

Compare the results against `docs/playwright-performance-baseline.md` or the
latest documented baseline, and report the observed baseline numbers in the
handoff instead of just saying the command passed. Meaningful regressions in
text entry, dropped characters, long tasks during typing, or loading/navigation
slowdown are unacceptable unless the product owner explicitly accepts the
regression.

## Shared-tree safety

Assume `main` is a shared working surface and every tracked, modified, or
untracked file is intentional. Preserve concurrent work.

- Do not delete, revert, rename, reorganize, refactor, or clean up outside the
  task explicitly requested by the user.
- Do not remove apparently dead or duplicate code; it may be incomplete work
  from another session.
- Do not make drive-by fixes. Report unrelated findings instead.
- Inspect existing changes before editing overlapping files. If concurrent work
  creates an unsafe conflict, stop and ask.
- Never hide work with `git stash` or by editing `.gitignore`.
- Never rewrite history or run destructive Git cleanup. In particular, do not
  use `git revert`, destructive `git reset`, broad `git restore`/`checkout`,
  `git clean`, force-push, interactive rebase, ref deletion, or hook bypasses
  without explicit in-conversation approval.
- If dangling Git objects are discovered before an approved destructive action,
  preserve them under `refs/recovery/`; never run `git gc` or `git prune`.
- Commit coherent, tested checkpoints. In a shared integration tree, include
  all compatible non-ignored state requested for the checkpoint and explain any
  files that must remain dirty.

## Completeness and validation

Do not leave orphan scaffolding. A new persisted record family normally needs
its Dexie table, translator, worker dispatch, sync registration, UI consumer,
and tests in the same coherent change.

## Unused-code and dead-path reporting

Run `bun run unused:report` when changing module boundaries, removing features,
or noticing stale paths while working. The Knip report is intentionally
report-first and non-blocking: use it to gather evidence for unused files,
dependencies, exports, duplicate exports, and unlisted imports, but do not
silently delete broad findings without task scope and review.

Feed unused-code and suspected dead-path findings back to the managing agent in
task comments, callbacks, or handoffs. If a notable stale path is outside the
active task, flag it to the product owner or manager after the update instead
of folding cleanup into unrelated work.

Static unused-code output does not prove runtime deadness. For suspected dead
runtime paths, recommend or add focused coverage, browser-flow probes, feature
flag coverage, or production telemetry before removing behavior.

Required baseline validation:

```bash
bun run check:public-source
bun run test
bun run build
git diff --check
```

If a change affects a real browser flow, state whether a manual or Playwright
pass remains necessary. Playwright must use a local Tower by default; external
backend tests require an explicit target and exact acknowledgement as enforced
by `playwright.config.cjs`.

## Conventional Commits

- Every commit must follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).
- Use `<type>[optional scope][!]: <description>`, with an optional body and footer(s).
- Use `feat` for new features and `fix` for bug fixes. Other suitable types include `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `perf`, `style`, and `revert`.
- Mark breaking changes with `!` before `:` and/or a `BREAKING CHANGE: <description>` footer.
- Keep unrelated changes in separate commits whenever practical.

## Active session queue handling

When running in an Autopilot session, inspect your own pending prompt queue at meaningful milestones during active work, when new work is reported, and before final handoff, using `bun /Users/mini/code/wm/autopilot/clis/wingman.ts session queue list`. Read each complete item and any referenced authoritative thread/task. Incorporate applicable steering; immediately consume only the exact item and revision actually incorporated using `bun /Users/mini/code/wm/autopilot/clis/wingman.ts session queue consume <id> --revision <read-revision> --reason <incorporation-reason>`. Consumption removes pending work while preserving history; merely listing or reading is not consumption. Keep unfinished/unrelated work and concurrent newer arrivals pending. Never clear the queue blindly or consume solely to suppress a follow-up turn. Recheck before handoff.

Supervised worker callbacks are separate: inspect `bun /Users/mini/code/wm/autopilot/clis/wingman.ts dispatch inbox`, review actual evidence and report/take necessary follow-up, then acknowledge and close only reviewed callbacks. Do not apply these commands to another session or imply monitoring after the process stops. Follow `/Users/mini/.codex/skills/wingman-sessions/SKILL.md` for revision conflicts and uncertain delivery, with Pete's explicit consume-on-incorporation policy taking precedence over older completion-only acknowledgement guidance.
