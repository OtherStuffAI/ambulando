# Excalidraw boards: agent workflow

An Excalidraw board is a private Flight Deck **File** whose immutable versions contain an
Excalidraw scene (`application/vnd.excalidraw+json`). Tower owns the board's identity, channel
permissions (`file.read` / `file.write`), version history and latest pointer. Canvas naplets only
reference a board; one board can appear in many naplets and canvases.

Humans edit in Canvas and press **Save**. Agents use the same signed Tower routes through
`scripts/excalidraw-board.mjs`. Both create immutable versions against the version they started
from, so neither can silently overwrite the other.

## Quick start

```bash
export WINGMAN_TOWER_URL=https://tower.example
WS=<workspace-id>

# 1. Find the board's File id (from the naplet, the channel Files list or `create`).
bun scripts/excalidraw-board.mjs versions --workspace $WS --file <board-file-id>

# 2. Read an exact version (default: latest). Writes the scene plus a sidecar
#    plan.excalidraw.wingman.json recording the base version.
bun scripts/excalidraw-board.mjs read --workspace $WS --file <board-file-id> --out plan.excalidraw

# 3. Edit plan.excalidraw locally (see "Editing rules"), then validate it.
bun scripts/excalidraw-board.mjs check --scene plan.excalidraw

# 4. Publish a new version against the base you read.
bun scripts/excalidraw-board.mjs publish --workspace $WS --file <board-file-id> \
  --scene plan.excalidraw --summary "Add deployment lane"
```

`publish` only uses a base you started from: `--base <version-id>` or the version `read` recorded in
the sidecar. It never substitutes the board's current head; without a base it refuses to run.
`publish --dry-run` validates the scene and base offline without contacting Tower.

Create a new board and link it on a canvas:

```bash
bun scripts/excalidraw-board.mjs create --workspace $WS --channel <channel-id> \
  --title "Release plan" [--scene seed.excalidraw] [--canvas <canvas-id> --x 80 --y 80]
```

Signing goes through the Autopilot capability broker (`wingman-capability.ts nip98`), exactly like
`scripts/publish-html-artifact.mjs`; the helper never handles a private key. Nothing is made public
and nothing is published through Blossom.

## Stale saves

`publish` sends `base_version_id`. If anyone saved after that version, Tower rejects the request
atomically with `409 stale_base_version`. The helper exits with code **3**, prints the current version,
and **does not modify your local scene file**. Then:

1. `read` the latest into a different file.
2. Merge by element `id`: keep elements you changed, take the latest for elements you did not touch,
   and add new elements from both sides.
3. `publish --base <latest-version-id>` (or re-read so the sidecar points at the latest).

Never force a save by publishing an unrelated base.

## Editing rules

The canonical scene is the working board, not an export:

- Keep every element's `id`. Change content by editing the element in place.
- On every element you change, increment `version` and set a new random integer `versionNonce`.
  Excalidraw and future reconciliation rely on these.
- Delete by setting `"isDeleted": true` and bumping `version`. Do not remove the element from the
  array; tombstones are required to merge with other editors.
- New elements need a unique `id`, `version: 1` and a `versionNonce`. Copy a similar existing
  element as a template so that required Excalidraw fields are present.
- Images live in `files` as `data:image/...` URLs keyed by the element's `fileId`. Supported types:
  PNG, JPEG, GIF, WebP, AVIF and SVG; up to 6 MiB each, 200 images and 24 MiB per board version.
- Only `viewBackgroundColor`, `gridSize`, `gridStep` and `gridModeEnabled` from `appState` are
  stored, and only when they differ from Excalidraw's defaults. Zoom, scroll and selection belong to each viewer.
- The helper also accepts the Artifact-style `{ "scene": { "elements": … } }` wrapper and rewrites
  it into the canonical shape.

`export --scene a.excalidraw --out public.excalidraw` writes a lossy public copy without deleted
elements. It is for sharing a picture of the board; never publish it back as the board.

## Version metadata

Each version records its author (`created_by_actor_npub`) and creation time in Tower. A summary
(`--summary`, at most 280 characters) is sent to Tower and also embedded in the saved scene as
`wingman.summary`, so it survives on Towers that do not yet store version summaries.

## Permissions

- Reading needs `file.read` on the board's channel; saving needs `file.write`.
- Canvas visibility never grants board access. A viewer who cannot read the board sees only
  “Ask your workspace owner for access.” and no board title, id or content.
- Removing someone from the channel revokes the board on their next canvas refresh. Their local
  draft and cached scene bytes are discarded at that point.
