# One small step

A self-contained HTML canvas example with an interactive three-step checklist.
It uses system fonts, inline CSS and JavaScript, and no external assets,
tracking, network calls or browser storage. Checkbox state is intentionally
session-only and resets when the iframe reloads. Canvas placement and the source
File use the existing canvas persistence and versioning rules.

Validate without contacting a backend:

```bash
bun scripts/publish-html-artifact.mjs examples/html-artifact --dry-run --smoke
```

Publish through the [existing HTML artefact workflow](../../docs/html-artifact-publishing.md).
Create a File once, retain the returned `file_id`, and use `--file` for later
versions. Link that File once to the intended canvas using the normal naplet API
or picker. Do not run publication or insertion on page load, or recreate a card
that a user has removed. Existing canvases and their layouts are user content.

No application seed, migration, new record family, or runtime dependency is
required. The folder is a reusable publishing input; Vite does not bundle it.
