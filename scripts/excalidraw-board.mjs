#!/usr/bin/env bun
// Agent helper for private Excalidraw boards stored as Tower Files.
// Usage and policy: docs/excalidraw-boards.md
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BOARD_CONTENT_TYPE,
  boardFileName,
  createEmptyBoardScene,
  exportPublicBoardScene,
  parseBoardScene,
  serializeBoardScene,
} from '../src/canvas/board-scene.js';
import { brokerSigner, defaultSignerCli, towerClient, TowerError } from './html-artifact/tower.mjs';

export const USAGE = `Read, edit and publish private Excalidraw boards (Flight Deck Files).

  bun scripts/excalidraw-board.mjs versions --file <id>
  bun scripts/excalidraw-board.mjs read     --file <id> [--version <id>] --out <scene.excalidraw>
  bun scripts/excalidraw-board.mjs publish  --file <id> --scene <scene.excalidraw> [--base <version-id>] [--summary <text>] [--dry-run]
  bun scripts/excalidraw-board.mjs create   --channel <id> --title <name> [--scene <file>] [--summary <text>]
                                            [--canvas <canvas-id> [--x 80 --y 80 --width 720 --height 520]]
  bun scripts/excalidraw-board.mjs check    --scene <file>
  bun scripts/excalidraw-board.mjs export   --scene <file> --out <public.excalidraw>

  Network commands also need --tower <origin> (or WINGMAN_TOWER_URL) and --workspace <id>.

  read     writes the exact version and a sidecar <out>.wingman.json recording its base version.
  publish  saves a NEW immutable version against --base or the version recorded by 'read' in the
           sidecar. It never uses the current head as a base. If someone saved meanwhile, Tower rejects
           it (exit 3) and your local scene file is left untouched. --dry-run validates only.
  export   writes a lossy public copy without deleted elements. Never publish an export as the board.

Signing uses the Autopilot capability broker; nothing is made public.`;

export const EXIT_STALE = 3;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) { options._.push(value); continue; }
    const key = value.slice(2);
    if (['json', 'help', 'dry-run'].includes(key)) options[key] = true;
    else options[key] = argv[++index];
  }
  return options;
}

const sidecarPath = scenePath => `${scenePath}.wingman.json`;

async function readSidecar(scenePath) {
  try { return JSON.parse(await readFile(sidecarPath(scenePath), 'utf8')); } catch { return null; }
}

/** Signed board operations shared by the CLI and tests (inject fetch/sign in tests). */
export function boardClient({ baseUrl, workspaceId, sign, fetchImpl = fetch }) {
  const client = towerClient({ baseUrl, workspaceId, sign, fetchImpl });
  const origin = String(baseUrl).replace(/\/+$/, '');
  const ws = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}`;
  return {
    ...client,
    async versions(fileId) {
      const payload = await client.listVersions(fileId);
      return { current_version_id: payload.current_version_id, versions: [...(payload.versions || [])].sort((a, b) => b.version_number - a.version_number) };
    },
    async readVersionBytes(fileId, versionId) {
      const url = `${origin}${ws}/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/object`;
      const { authorization } = await sign(url, 'GET', null);
      const response = await fetchImpl(url, { headers: { Authorization: authorization } });
      if (!response.ok) throw new TowerError(response.status, response.status === 404 ? 'not_found' : 'read_failed', 'Board version is unavailable (missing or not permitted)');
      return new Uint8Array(await response.arrayBuffer());
    },
    async read(fileId, versionId = '') {
      const { current_version_id: current, versions } = await this.versions(fileId);
      const target = versions.find(row => row.id === (versionId || current));
      if (!target) throw new Error(`Version ${versionId || current} is not in this board's history`);
      const bytes = await this.readVersionBytes(fileId, target.id);
      if (target.sha256_hex && sha256(bytes) !== target.sha256_hex) throw new Error('Board version integrity check failed');
      return { scene: parseBoardScene(bytes), version: target, current_version_id: current };
    },
    async publish(fileId, scene, { baseVersionId, summary = '' }) {
      if (!uuid.test(String(baseVersionId || ''))) throw new Error('A base version id is required; run `read` first or pass --base');
      const { bytes } = serializeBoardScene(scene, { summary, baseVersionId });
      const objectId = await client.uploadObject({ bytes, contentType: BOARD_CONTENT_TYPE, fileName: 'board.excalidraw' });
      const body = { base_version_id: baseVersionId, storage_object_id: objectId, client_mutation_id: crypto.randomUUID(), ...(summary ? { summary } : {}) };
      return (await client.createVersion(fileId, body)).version;
    },
    async create(channelId, title, scene, { summary = '' } = {}) {
      const { bytes } = serializeBoardScene(scene, { summary });
      const objectId = await client.uploadObject({ bytes, contentType: BOARD_CONTENT_TYPE, fileName: boardFileName(title) });
      const created = await client.createFile(channelId, { storage_object_id: objectId, display_name: boardFileName(title), metadata: { kind: 'excalidraw_board', title }, ...(summary ? { summary } : {}) });
      return created.file;
    },
  };
}

function requireTower(options) {
  const tower = options.tower || process.env.WINGMAN_TOWER_URL;
  if (!tower || !uuid.test(String(options.workspace || ''))) throw new Error('--tower and --workspace are required');
  return boardClient({ baseUrl: tower, workspaceId: options.workspace, sign: brokerSigner({ cli: options['signer-cli'] || defaultSignerCli() }) });
}

function requireUuid(options, key) {
  if (!uuid.test(String(options[key] || ''))) throw new Error(`--${key} must be a UUID`);
  return options[key];
}

export async function run(argv, { out = console.log, err = console.error, clientFactory = requireTower } = {}) {
  const options = parseArgs(argv);
  const [command] = options._;
  if (options.help || !command) { out(USAGE); return options.help ? 0 : 2; }
  if (command === 'check') {
    const { bytes, scene } = serializeBoardScene(parseBoardScene(await readFile(path.resolve(options.scene))));
    out(JSON.stringify({ ok: true, elements: scene.elements.length, deleted: scene.elements.filter(row => row.isDeleted).length, images: Object.keys(scene.files).length, bytes: bytes.byteLength }));
    return 0;
  }
  if (command === 'export') {
    const scene = parseBoardScene(await readFile(path.resolve(options.scene)));
    await writeFile(path.resolve(options.out), JSON.stringify(exportPublicBoardScene(scene), null, 2));
    err(`Wrote a public export to ${options.out}. It omits deleted elements; do not publish it back as the board.`);
    return 0;
  }
  let client = null;
  const tower = () => { client ||= clientFactory(options); return client; };
  if (command === 'versions') {
    const result = await tower().versions(requireUuid(options, 'file'));
    out(JSON.stringify(result.versions.map(row => ({ id: row.id, version_number: row.version_number, current: row.id === result.current_version_id, author_npub: row.created_by_actor_npub, summary: row.summary || '', created_at: row.created_at, size_bytes: row.size_bytes })), null, 2));
    return 0;
  }
  if (command === 'read') {
    const fileId = requireUuid(options, 'file');
    if (!options.out) throw new Error('--out is required');
    const { scene, version, current_version_id: current } = await tower().read(fileId, options.version || '');
    const target = path.resolve(options.out);
    await writeFile(target, JSON.stringify(scene, null, 2));
    await writeFile(sidecarPath(target), JSON.stringify({ workspace_id: options.workspace, file_id: fileId, base_version_id: version.id, base_version_number: version.version_number, latest_when_read: current, sha256: version.sha256_hex, read_at: new Date().toISOString() }, null, 2));
    err(`Read version ${version.version_number}${version.id === current ? ' (latest)' : ''} → ${options.out}`);
    return 0;
  }
  if (command === 'publish') {
    const fileId = requireUuid(options, 'file');
    const scenePath = path.resolve(options.scene || '');
    const sidecar = await readSidecar(scenePath);
    if (sidecar?.file_id && sidecar.file_id !== fileId) throw new Error(`The scene was read from board ${sidecar.file_id}, not ${fileId}`);
    const baseVersionId = options.base || sidecar?.base_version_id;
    // Stale-edit protection depends on a base the editor actually started from.
    if (!uuid.test(String(baseVersionId || ''))) throw new Error('No base version: run `read` to create the sidecar, or pass --base <version-id> you started from');
    const scene = parseBoardScene(await readFile(scenePath));
    if (options['dry-run']) {
      const { bytes } = serializeBoardScene(scene, { summary: options.summary || '', baseVersionId });
      out(JSON.stringify({ ok: true, dry_run: true, file_id: fileId, base_version_id: baseVersionId, bytes: bytes.byteLength, elements: scene.elements.length }));
      return 0;
    }
    try {
      const version = await tower().publish(fileId, scene, { baseVersionId, summary: options.summary || '' });
      await writeFile(sidecarPath(scenePath), JSON.stringify({ ...(sidecar || {}), file_id: fileId, base_version_id: version.id, base_version_number: version.version_number, published_at: new Date().toISOString() }, null, 2));
      out(JSON.stringify({ ok: true, file_id: fileId, version_id: version.id, version_number: version.version_number }));
      return 0;
    } catch (error) {
      if (error instanceof TowerError && error.status === 409) {
        const current = error.body?.current_version || error.body?.error?.details?.current_version || null;
        err(`Rejected: board was saved by someone else since version ${sidecar?.base_version_number ?? baseVersionId}. Current is ${current ? `v${current.version_number} (${current.id})` : 'newer'}.`);
        err('Your scene file is unchanged. Read the latest into a separate file, merge by element id, then publish with --base <latest>.');
        out(JSON.stringify({ ok: false, code: 'stale_base_version', current_version: current }));
        return EXIT_STALE;
      }
      throw error;
    }
  }
  if (command === 'create') {
    const channelId = requireUuid(options, 'channel');
    const title = String(options.title || '').trim() || 'Untitled board';
    const scene = options.scene ? parseBoardScene(await readFile(path.resolve(options.scene))) : createEmptyBoardScene();
    const file = await tower().create(channelId, title, scene, { summary: options.summary || '' });
    let naplet = null;
    if (options.canvas) {
      const canvasId = requireUuid(options, 'canvas');
      naplet = (await tower().addNaplet(canvasId, { source: { type: 'excalidraw', id: file.id }, title, layout: { x: Number(options.x || 80), y: Number(options.y || 80), width: Number(options.width || 720), height: Number(options.height || 520), z: 1 } }))?.naplet || null;
    }
    out(JSON.stringify({ ok: true, file_id: file.id, version_id: file.current_version_id, naplet_id: naplet?.id || null }));
    return 0;
  }
  out(USAGE);
  return 2;
}

if (import.meta.main) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof TowerError ? `Tower ${error.message}` : error.message);
    process.exitCode = 1;
  });
}
