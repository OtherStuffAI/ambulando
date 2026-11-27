# Publishing HTML artefacts to a canvas

`scripts/publish-html-artifact.mjs` turns a local folder (an `index.html` plus
local CSS, JS and images) into a private Flight Deck File that a canvas naplet
can show. Images become private sibling Files in the same channel, referenced by
exact File, version and sha256. Nothing is made public and no Blossom or
anonymous URL is used. Rendering, authority and sandbox rules are described in
[`docs/design/canvas.md`](design/canvas.md#trusted-html-naplets).

## Commands

Check a folder without contacting Tower:

```bash
bun scripts/publish-html-artifact.mjs path/to/artefact --dry-run
bun scripts/publish-html-artifact.mjs path/to/artefact --dry-run --out /tmp/review --smoke
```

`--out` writes the packaged `index.html`, a `preview.html` that opens directly
in a browser, and `assets/`. `--smoke` renders the package in the real canvas
sandbox with Playwright and fails on CSP violations, script errors or images
that do not render.

Publish a new artefact (prints `file_id`, `version_id` and an update command):

```bash
bun scripts/publish-html-artifact.mjs path/to/artefact \
  --tower https://tower.example --workspace <workspace-id> --channel <channel-id> \
  [--title "Display name"] [--canvas <canvas-id>]
```

`--canvas` also adds a naplet that follows the latest version.

Publish a new version of the same artefact:

```bash
bun scripts/publish-html-artifact.mjs path/to/artefact \
  --tower https://tower.example --workspace <workspace-id> --file <html-file-id> --base <read-version-id>
```

Always pass `--file` for updates. Without it, a new, unrelated File is created.
Naplets that follow latest show the new version immediately. Pinned naplets keep
their version until a canvas manager chooses "Follow latest". Images whose bytes
are unchanged reuse their previous File version; changed images become new
versions of the same image File. If someone else publishes between your read and
write, Tower rejects the stale `base_version_id`. The helper reports this, and
retain your source, read the latest version separately and reconcile before publishing with its captured base. Updates require `--base` from the source read before authoring.

`--json` suppresses progress output. `WINGMAN_TOWER_URL` can replace `--tower`.

## Goal-associated agent outputs

New HTML and private image Files inherit the primary goal of the current agent session's authoritative chat. The shared publisher reads session routing with `wingman.ts flightdeck context --json`, validates the workspace/backend and thread, then resolves the Goal File under normal ACLs with its schema and exact-version hash. Only `ambulando_goal: { version: 1, goal_file_id }` references go into File metadata; goal content never becomes visible HTML or chat boilerplate. A denied Goal read retains only the authoritative reference. Missing, malformed or accessible non-Goal targets stop creation.

Use `--chat-thread <thread-uuid>` when explicitly publishing for another accessible chat in the chosen workspace. This reads the named thread; it does not trust a copied goal title or accept an arbitrary goal override. `--context-cli <path-to-wingman.ts>` or `WINGMAN_CONTEXT_CLI` selects the supported context helper. Outside an agent session (`SESSION_ID` absent), publication has no inferred chat association. Context-read failures in an agent session are errors, not silent unassociated publication.

The shared `towerClient.createFile` path also covers whiteboards, new napplet source Files and migrated artefact Files. New records retain existing format/provenance metadata, and their saved association is read back. Existing File revisions keep their current association; opening or revising one in another goal's chat does not reassign it. An uncertain post-create readback names the created File and requires inspection before retrying. These source checks do not establish live agent receipt, client listing or native navigation.

## Signing

Every request is NIP-98 signed through the Autopilot capability broker:
`bun <autopilot>/clis/wingman-capability.ts nip98 --url … --method … [--body-file …]`.
The helper never reads keys or bearer tokens. The broker CLI path resolves from
`--signer-cli`, then `$WINGMAN_CAPABILITY_CLI`, then
`$AUTOPILOT_REPO/clis/wingman-capability.ts`, and finally
`~/code/wm/autopilot/clis/wingman-capability.ts`. The signing identity must have
`file.write` on the channel, and canvas manage rights if you pass `--canvas`.

## What a folder may contain

| Supported | Becomes |
| --- | --- |
| `<link rel="stylesheet" href="local.css">` | inline `<style>` (local `url()` images up to 256 KiB become `data:`) |
| `<script src="local.js">`, inline scripts, `type="module"` without imports | inline `<script>` |
| `<img src="local.png">` (png, jpeg, gif, webp, avif, svg; 8 MiB each) | `<img data-asset="name">` delivered privately |
| `<a href="#id">` | scrolls within the artefact |
| inline `data:` images, `<script type="application/json">` data | kept |

These are rejected, with every problem listed at once:

- remote scripts, stylesheets, fonts and images
- absolute paths, paths or symlinks that leave the folder, and files that do not exist
- `srcset`, CSS `@import`, and module `import`
- non-image `<img>` sources, and images whose bytes do not match their extension
- more than 64 images or 32 MiB of images in total, and HTML larger than 2 MiB

These produce warnings and are made inert: links to local files are removed
(images stay visible), external links and forms are kept but blocked, and
network calls in scripts are blocked by `connect-src 'none'`.

To set a background image, use `<div data-asset-background="name">`. Scripts can
call `window.wingmanAssets.url(name)` after the `wingman:assets-ready` document
event.

## Limits of the sandbox

Artefacts run as trusted-author JavaScript in an opaque, credentialless iframe
with no network access through `fetch`, XHR, WebSocket or subresources. They
cannot see Flight Deck, the user's keys or Tower URLs. A script can still
navigate its own frame. The canvas detects this and replaces the frame, but it
does not prevent data in that navigation URL from leaving the browser. Publish
only artefacts whose authors you trust with the data they display.
