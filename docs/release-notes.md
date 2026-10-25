# Flight Deck release notes

Flight Deck stores user-visible release notes in root-level `release-notes.json`. The Vite build validates that manifest and embeds its ordered history in `dist/version.json`; release notes are static build metadata, not Tower workspace records.

## Add the next release

1. Read `absoluteVersion` from `.build-meta.json` and use the next integer as `buildNumber`.
2. Append one entry to `release-notes.json` in ascending `buildNumber` order. Give it a short `label` and concise plain-text `notes` (each note is limited to 280 characters).
3. Run `bun run test`, then run `bun run build` once for the release output. The build must reach the authored build number; it rejects notes assigned to a future build.
4. Run `bun run verify:dist`, then commit the manifest, `.build-meta.json`, and
   source changes. `dist/` is generated deployment output and is not committed.

The absolute build number is the comparison key. The human-readable timestamp build ID is retained for display and must not be sorted lexically.

An internal build with no user-visible change does not need a manifest entry. If recording that build explicitly is useful, add an entry with a meaningful `label`, an empty `notes` array, and `"noUserVisibleChanges": true`; the upgrade panel will say that the build has no user-visible changes. Never add placeholder or invented notes.

Entries are immutable history after release. Do not reuse or reorder build numbers. The build and tests reject malformed entries, duplicate/out-of-order build numbers, empty visible releases, and ambiguous no-change entries.

Native store packaging uses `bun run test:release`: all functional tests remain
mandatory. The 20,000-row worker benchmark records host event-loop delay without
using its 50 ms observation as a release gate. `bun run test` retains the strict
benchmark threshold for dedicated performance investigation. Worker results and
actual event-loop progress remain asserted in both modes. Never suppress a
functional failure as benchmark noise.

Release validation limits Vitest to two workers to reduce CPU contention with
simultaneous native packaging and other release sessions. The same
full functional suite, transaction deadline and event-loop assertions still run.
A default-parallel failure remains evidence; rerun the complete bounded suite
before treating resource contention as resolved.
