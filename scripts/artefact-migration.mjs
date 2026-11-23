// Latest-only, provenance-bound import. Original sources are never mutated.
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeBoardScene } from '../src/canvas/board-scene.js';
import { readSystemFlow, FLOW_CONTENT_TYPE } from '../src/system-flow.js';
import { packageArtifactFolder, withManifest } from './html-artifact/package.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function migrationSource({ folder, type, sourceUrl, sourceVersion, title, legacyNavigationReviewed = false }) {
  const url = new URL(sourceUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !sourceVersion || !title) throw Error('Use a canonical source URL/version/title without credentials or access codes.');
  const root = await realpath(folder), sourceFiles = [];
  let sourceBytes = 0;
  const read = async name => {
    const file = await realpath(path.resolve(root, name));
    if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) throw Error('Source path escapes the version folder.');
    if ((await stat(file)).size > 48 * 1024 * 1024) throw Error('Source file exceeds import limit.');
    const bytes = await readFile(file);
    sourceBytes += bytes.length;
    if (sourceBytes > 48 * 1024 * 1024 || sourceFiles.length >= 512) throw Error('Exact source bundle exceeds import limits.');
    sourceFiles.push({ path: name, sha256_hex: hash(bytes), base64: bytes.toString('base64') }); return bytes;
  };
  let bytes, contentType, assets = [], packaged;
  if (type === 'excalidraw') {
    const source = JSON.parse(await read('excalidraw-scene.json'));
    bytes = Buffer.from(JSON.stringify(normalizeBoardScene(source.scene || source)));
    contentType = 'application/vnd.excalidraw+json';
  } else if (type === 'system-flow') {
    const source = await read('flow.json'), flow = JSON.parse(source);
    if (flow.schemaVersion === 3) {
      flow.scenes = {};
      const expected = new Set((flow.whiteboards || []).flatMap(board => [board.sceneId, board.currentSceneId, board.proposedSceneId].filter(Boolean)));
      const entries = await readdir(path.join(root, 'scenes'), { withFileTypes: true });
      for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || !/^[A-Za-z0-9_-]{1,100}\.json$/.test(entry.name)) throw Error('Unsupported scene directory entry; no source may be dropped.');
        const id = entry.name.slice(0,-5);
        flow.scenes[id] = JSON.parse(await read(`scenes/${entry.name}`));
        if (!expected.has(id)) throw Error('Unreferenced legacy scene requires explicit reconciliation; no source may be dropped.');
      }
      if (Object.keys(flow.scenes).length !== expected.size) throw Error('Missing linked scene source.');
    }
    readSystemFlow(JSON.stringify(flow));
    bytes = flow.schemaVersion === 3 ? Buffer.from(JSON.stringify(flow)) : source;
    contentType = FLOW_CONTENT_TYPE;
  } else if (type === 'html') {
    packaged = await packageArtifactFolder(root);
    if (packaged.warnings.some(warning => !legacyNavigationReviewed || !['links to local files were removed: navigation is disabled inside canvas naplets (images remain visible inline)', 'external links are kept but inert: canvas naplets cannot navigate or open windows'].includes(warning))) throw Error(`Resolve packaging changes explicitly before migration: ${packaged.warnings.join('; ')}`);
    assets = packaged.assets;
    // Retain exact authoring files. Runtime caches/drafts/comments remain in the legacy archive.
    const walk = async relative => { for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw Error('Source symlinks are not imported.');
      if (entry.isDirectory()) await walk(name);
      else if (!/(?:^|\/)(?:fdback|\.\w)|\.draft\./.test(name)) await read(name);
    } };
    await walk(''); bytes = Buffer.from(packaged.html); contentType = 'text/html';
  } else throw Error('Unsupported migration type.');
  if (type !== 'html') await read('index.html');
  const manifest = sourceFiles.map(({ path, sha256_hex }) => ({ path, sha256_hex })).sort((a,b) => a.path.localeCompare(b.path));
  const sourceHash = hash(Buffer.from(JSON.stringify(manifest)));
  const provenance = { ...(packaged?.warnings.length ? { limitations: ['History and external navigation remain at the legacy original.'], legacy_navigation_reviewed: true } : {}), schema_version: 1, source_url: url.href, source_version: sourceVersion, source_sha256_hex: sourceHash, history_policy: 'latest-selected-only', original_unchanged: true };
  const archive = Buffer.from(JSON.stringify({ schema_version: 1, provenance, files: sourceFiles }));
  if (archive.length > 64 * 1024 * 1024) throw Error('Exact source archive exceeds 64 MiB.');
  return { title, type, bytes, contentType, assets, packaged, archive, provenance, manifest };
}
export async function importMigration(client, workspaceId, channelId, source, { audienceVerified = false } = {}) {
  if (!audienceVerified) throw Error('Review source and destination audiences before importing.');
  const root = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}`;
  const channel = (await client.request('GET', `${root}/channels/${encodeURIComponent(channelId)}`)).channel;
  if (channel?.id !== channelId || channel.workspace_id !== workspaceId || channel.archived_at || channel.deleted_at) throw Error('Destination channel unavailable.');
  const listing = await client.request('GET', `${root}/channels/${encodeURIComponent(channelId)}/files?limit=200`);
  if (!Array.isArray(listing.files) || listing.files.length >= 200 || listing.next_cursor || listing.has_more || listing.partial) throw Error('Complete destination provenance list required; do not retry blindly.');
  const matches = listing.files.filter(f => f.metadata?.migration?.source_url === source.provenance.source_url && f.metadata.migration.source_version === source.provenance.source_version);
  const roles = new Map();
  for (const file of matches) {
    if (file.metadata.migration.source_sha256_hex !== source.provenance.source_sha256_hex) throw Error('Source version changed since import; inspect provenance conflict.');
    const role = file.metadata.migration.role;
    if (roles.has(role)) throw Error('Duplicate provenance mapping requires review.'); roles.set(role, file);
  }
  const verify = async (file, expectedBytes) => {
    const history = await client.listVersions(file.id), version = history.versions.find(v => v.id === history.current_version_id);
    const actual = await client.readVersionBytes(file.id, version.id);
    if (version.sha256_hex !== hash(actual)) throw Error('Imported source integrity mismatch.');
    if (expectedBytes && !actual.equals(expectedBytes)) throw Error('Imported source differs; inspect existing revisions before retrying.');
    return { file_id: file.id, version_id: version.id, version_number: version.version_number, sha256_hex: hash(actual) };
  };
  const create = async (role, bytes, contentType, title, metadata = {}) => {
    if (roles.has(role)) return roles.get(role);
    const storageId = await client.uploadObject({ bytes, contentType, fileName: role === 'source' ? 'legacy-source.json' : title });
    const result = await client.createFile(channelId, { storage_object_id: storageId, display_name: title.slice(0,200), metadata: { ...metadata, migration: { ...source.provenance, role } } });
    // Uncertain creation must be reconciled by listing provenance before a retry.
    if (!result.file?.id) throw Error('Creation unconfirmed; inspect destination provenance before retrying.');
    roles.set(role, result.file); return result.file;
  };
  // Source first: partial progress is discoverable under the same provenance.
  const archive = await create('source', source.archive, 'application/json', `${source.title} · original source`);
  const archiveResult = await verify(archive, source.archive);
  const manifest = [];
  for (const asset of source.assets) {
    const file = await create(`asset:${asset.name}`, asset.bytes, asset.contentType, `${source.title} · ${asset.name}`, { html_artifact_asset: true });
    const result = await verify(file, Buffer.from(asset.bytes));
    manifest.push({ name: asset.name, file_id: file.id, version_id: result.version_id, sha256: asset.sha256 });
  }
  const bytes = source.type === 'html' ? Buffer.from(withManifest(source.packaged.html, manifest)) : source.bytes;
  const primary = await create('primary', bytes, source.contentType, source.title, {
    ...(source.type === 'html' ? { html_artifact: true } : source.type === 'excalidraw' ? { kind: 'excalidraw_board' } : {}),
    artefact: { schema_version: 1, type: source.type, format_version: 1, editor_id: `builtin.${source.type}` },
    original_source: { file_id: archive.id, version_id: archiveResult.version_id },
  });
  const result = await verify(primary, roles.has('primary') && matches.some(f=>f.id===primary.id) ? null : bytes);
  // Do not overwrite later user edits on a repeated import. The immutable first version is checked separately.
  const versions = await client.listVersions(primary.id), first = versions.versions.find(v => v.version_number === 1);
  if (!first || !(await client.readVersionBytes(primary.id, first.id)).equals(bytes)) throw Error('Original imported revision differs from source.');
  return { ...result, channel_id: channelId, workspace_id: workspaceId, provenance: source.provenance, original_source: archiveResult, assets: manifest, reused: matches.some(f=>f.id===primary.id) };
}
