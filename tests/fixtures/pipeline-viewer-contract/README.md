# Backend-generated viewer fixtures

These synthetic fixtures are generated with the sibling Autopilot's committed
Bird v2 definitions, PipelineStore evidence archive and pipeline-viewer DTOs.
They contain no live user values, credentials or private keys.

Regenerate from the Flight Deck root:

```sh
node scripts/generate-pipeline-viewer-contract-fixtures.mjs ../autopilot
```

The generator invokes `pipeline-viewer-contract-fixtures.ts`, which imports the
backend's actual PipelineStore, metadata and viewer DTO APIs against an isolated
temporary SQLite database and ignored output directory, then copies synthetic JSON
into this checkout. It never rewrites sibling source or modifies backend fixtures.
Measurements remain ignored.

`runtime/` snapshots come from actual backend runner tests (retry, loop, resume,
parallel, nested agents, blocks and Bird outcomes). To regenerate them in the
owning backend checkout, follow `docs/fixtures/pipeline-viewer/runtime/README.md`,
then run this copy/generation command. Frontend correction tests run both the
actual parser and diagram projection, assert every execution remains visible
exactly once, and check complete definitions contain every executed logical key.

Fixtures exercise actual defined child/loop nodes, SHA-256 revision tokens,
native `ok`/`skipped` statuses, exact long text, full records across pages,
redaction availability and separate delivery confirmation. Stable schema and
relationships matter; run/evidence UUIDs and timestamps are synthetic and may
change when regenerated. Measurements and operational logs are not committed.

The copy step normalizes the hostile synthetic mention's four-character display
label to `Test` in two Bird wrapper fixtures to satisfy public-source policy.
Its width/escaping, IDs, timestamps, byte counts, execution graph and capture
structure stay unchanged. All other runtime JSON is copied verbatim.
