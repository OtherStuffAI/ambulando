#!/usr/bin/env bun
// Agent helper for Canvas naplet references copied from Ambulando.
// Usage and policy: docs/canvas-references.md
import { parseCanvasReference } from '../src/canvas/references.js';
import { brokerSigner, defaultSignerCli, towerClient, TowerError } from './html-artifact/tower.mjs';

export const USAGE = `Resolve a Canvas naplet reference (the link from a naplet's "Copy reference").

  bun scripts/canvas-reference.mjs parse   --url <reference>
  bun scripts/canvas-reference.mjs resolve --url <reference> [--tower <origin>]

  A reference is <ambulando-origin>/canvas.html?workspaceid=…&canvasid=…&napletid=…
  (a Markdown link wrapping that URL is accepted too).

  parse    prints the workspace, canvas and naplet ids without contacting Tower.
  resolve  reads the canvas snapshot from Tower (--tower or WINGMAN_TOWER_URL) as the signing
           agent and prints that naplet's title, layout and source (type, id, pinned version).
           Missing, restricted and malformed references exit 4 with one neutral message.

Signing uses the Autopilot capability broker. The link itself grants nothing.`;

export const EXIT_UNAVAILABLE = 4;
const UNAVAILABLE = 'Reference unavailable: it was removed, is malformed, or this identity cannot read it.';

class UnavailableError extends Error {}

export function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) { options._.push(value); continue; }
    const key = value.slice(2);
    if (['help', 'json'].includes(key)) options[key] = true;
    else options[key] = argv[++index];
  }
  return options;
}

/** Ids from a reference URL or a Markdown link around one. */
export function referenceIds(input) {
  const raw = String(input || '').trim();
  const href = raw.match(/\]\((https?:\/\/[^)\s]+)\)\s*$/)?.[1] || raw;
  let url;
  try { url = new URL(href); } catch { throw new UnavailableError(UNAVAILABLE); }
  if (!/\/canvas\.html$/.test(url.pathname)) throw new UnavailableError(UNAVAILABLE);
  const parsed = parseCanvasReference(url.search);
  if (!parsed.workspaceId || !parsed.canvasId || !parsed.napletId) throw new UnavailableError(UNAVAILABLE);
  return { origin: url.origin, workspace_id: parsed.workspaceId, canvas_id: parsed.canvasId, naplet_id: parsed.napletId };
}

/** Next agent step for a resolved source; only ids Tower returned to this identity. */
function sourceHint(source) {
  if (source.type === 'excalidraw') return `bun scripts/excalidraw-board.mjs read --file ${source.id} --out board.excalidraw`;
  if (source.type === 'html') return source.version_id ? `HTML File ${source.id}, pinned to version ${source.version_id}` : `HTML File ${source.id}, following its latest version`;
  if (source.type === 'canvas') return `Canvas ${source.id}: resolve its own snapshot`;
  return `${source.type} record ${source.id}`;
}

/** Reads the authoritative snapshot and returns the referenced naplet, or throws UnavailableError. */
export async function resolveReference(ids, client) {
  let snapshot;
  try {
    snapshot = await client.request('GET', `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(ids.workspace_id)}/canvases/${encodeURIComponent(ids.canvas_id)}/snapshot`);
  } catch (error) {
    if (error instanceof TowerError && [401, 403, 404].includes(error.status)) throw new UnavailableError(UNAVAILABLE);
    throw error;
  }
  const naplet = (snapshot?.naplets || []).find(row => row.id === ids.naplet_id);
  if (!naplet || naplet.access !== 'ready' || !naplet.source?.type || !naplet.source?.id) throw new UnavailableError(UNAVAILABLE);
  const source = { type: naplet.source.type, id: naplet.source.id, version_id: naplet.source.version_id || null };
  return {
    workspace_id: ids.workspace_id,
    canvas: { id: ids.canvas_id, title: snapshot.canvas?.title || '' },
    naplet: { id: naplet.id, title: naplet.title || '', layout: naplet.layout || null, source },
    next: sourceHint(source),
  };
}

function towerFor(options, ids) {
  const tower = options.tower || process.env.WINGMAN_TOWER_URL;
  if (!tower) throw new Error('--tower (or WINGMAN_TOWER_URL) is required for resolve');
  return towerClient({ baseUrl: tower, workspaceId: ids.workspace_id, sign: brokerSigner({ cli: options['signer-cli'] || defaultSignerCli() }) });
}

export async function run(argv, { out = console.log, err = console.error, clientFactory = towerFor } = {}) {
  const options = parseArgs(argv);
  const [command] = options._;
  if (options.help || !['parse', 'resolve'].includes(command)) { out(USAGE); return options.help ? 0 : 2; }
  try {
    const ids = referenceIds(options.url);
    if (command === 'parse') { out(JSON.stringify(ids, null, 2)); return 0; }
    out(JSON.stringify(await resolveReference(ids, clientFactory(options, ids)), null, 2));
    return 0;
  } catch (error) {
    if (!(error instanceof UnavailableError)) throw error;
    err(error.message);
    return EXIT_UNAVAILABLE;
  }
}

if (import.meta.main) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof TowerError ? `Tower ${error.message}` : error.message);
    process.exitCode = 1;
  });
}
