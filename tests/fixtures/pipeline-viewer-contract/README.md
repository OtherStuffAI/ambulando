# Backend-generated viewer fixtures

These synthetic fixtures are generated with the sibling Autopilot's committed
Bird v2 definitions, PipelineStore evidence archive and pipeline-viewer DTOs.
They contain no live user values, credentials or private keys.

Regenerate from the Flight Deck root:

```sh
node scripts/generate-pipeline-viewer-contract-fixtures.mjs ../autopilot
```

The generator runs against an isolated temporary SQLite database and writes only
Flight Deck fixture files. It places the extra synthetic array capture before the
completed snapshot so that the summary advertises its evidence ID; the upstream
fixture script originally captured this extra record after that snapshot. This
ordering difference is test-only and was reported to the backend manager.

Fixtures exercise actual defined child/loop nodes, SHA-256 revision tokens,
native `ok`/`skipped` statuses, exact long text, full records across pages,
redaction availability and separate delivery confirmation. Stable schema and
relationships matter; run/evidence UUIDs and timestamps are synthetic and may
change when regenerated. Measurements and operational logs are not committed.
