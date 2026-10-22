# Canvas naplet references: agent workflow

A person can choose **Copy reference** in any readable naplet's cog menu on a Canvas and paste the
result into chat, a task or a document. It is a Markdown link:

```text
[Release plan · Roadmap](https://ambulando.example/canvas.html?workspaceid=<workspace-id>&canvasid=<canvas-id>&napletid=<naplet-id>)
```

The label is `<naplet title> · <canvas title>`. The URL carries three Tower ids and nothing else:

| Query | Meaning |
| --- | --- |
| `workspaceid` | Tower workspace id (not the browser-local `workspacekey`) |
| `canvasid` | Canvas id |
| `napletid` | The naplet on that canvas (a canvas-layer id, not the source record id) |

A reference contains no session, token, local workspace key, source type or source id. It grants no
access: whoever opens or resolves it needs normal read access to the canvas, and to the naplet's
source to see its content. There is no share-grant record.

## Resolve a reference

```bash
export WINGMAN_TOWER_URL=https://tower.example

# Offline: just the ids (accepts the URL or the whole Markdown link).
bun scripts/canvas-reference.mjs parse --url '<reference>'

# Signed read of the canvas snapshot as this agent; prints the naplet and its source.
bun scripts/canvas-reference.mjs resolve --url '<reference>'
```

`resolve` performs `GET /api/v4/flightdeck-pg/workspaces/:workspaceId/canvases/:canvasId/snapshot`
with NIP-98 signing through the Autopilot capability broker (the same signer as
`scripts/excalidraw-board.mjs`), finds `napletid` in `naplets`, and prints:

```json
{
  "workspace_id": "<workspace-id>",
  "canvas": { "id": "<canvas-id>", "title": "Roadmap" },
  "naplet": {
    "id": "<naplet-id>",
    "title": "Release plan",
    "layout": { "x": 80, "y": 80, "width": 640, "height": 460, "z": 3 },
    "source": { "type": "excalidraw", "id": "<file-id>", "version_id": null }
  },
  "next": "bun scripts/excalidraw-board.mjs read --file <file-id> --out board.excalidraw"
}
```

Use `naplet.source` to read the actual record through its own authorized route:

| `source.type` | Source record | Next step |
| --- | --- | --- |
| `excalidraw` | Board File | `scripts/excalidraw-board.mjs read --file <id>` (see `docs/excalidraw-boards.md`) |
| `html` | HTML artefact File; `version_id` set when pinned, `null` when following latest | File version routes (see `docs/html-artifact-publishing.md`) |
| `document` | Document | Document routes |
| `task_list` | Channel whose tasks are shown | Channel task routes |
| `chat_thread` | Thread | Thread/message routes |
| `canvas` | Another canvas (Canvas Link) | Resolve that canvas's snapshot |

The snapshot is authoritative. Do not trust the Markdown label: titles can change after copying, and
the label may be stale.

## Unavailable references

`resolve` exits with code **4** and one neutral message when the naplet was removed, the reference is
malformed, the canvas is denied (`401`/`403`/`404`) or the naplet is restricted to this identity. It
never prints the restricted naplet's title, type or ids. Report the reference as unavailable; do not
retry with another identity or ask for broader access unless the user asks. Other Tower failures
(5xx, network) exit `1` with the error.

In the browser, the same cases open the canvas (when permitted) with one neutral message. A valid
reference selects, centres, focuses and briefly highlights the naplet once per page load. It never
writes the shared canvas viewport.

## Creating references as an agent

To point a person at a naplet, build the same URL from ids you already read through Tower:
`<ambulando-origin>/canvas.html?workspaceid=…&canvasid=…&napletid=…`. Use the deployment's Ambulando
origin, never a Tower origin. Never add `workspacekey`, tokens or source ids. Ordinary canvas links
(`/canvas.html?workspacekey=…&canvasid=…`) remain valid for the browser that produced them only.
