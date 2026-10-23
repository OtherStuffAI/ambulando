#!/usr/bin/env bun
// Publish a local HTML artefact folder as a private Tower File version.
// Usage and policy: docs/html-artifact-publishing.md
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { ArtifactPackageError, packageArtifactFolder, previewHtml, readManifest, withManifest } from './html-artifact/package.mjs';
import { brokerSigner, defaultSignerCli, towerClient, TowerError } from './html-artifact/tower.mjs';

const USAGE = `Publish a local HTML artefact folder to a private Flight Deck File.

  bun scripts/publish-html-artifact.mjs <folder> --dry-run [--out <dir>] [--smoke]
  bun scripts/publish-html-artifact.mjs <folder> --tower <origin> --workspace <id> --channel <id>
      [--file <html-file-id>] [--title <name>] [--canvas <canvas-id>] [--smoke] [--json]

  <folder>          Folder containing index.html (override with --entry <path>)
  --dry-run         Package and validate only; never contacts Tower
  --out <dir>       With --dry-run: write index.html, preview.html and assets/ for review
  --smoke           Render the packaged HTML in the real canvas sandbox (Playwright)
  --tower           Tower origin, e.g. https://tower.example (or WINGMAN_TOWER_URL)
  --workspace       Flight Deck workspace id
  --channel         Channel that owns the HTML File and its private image Files
  --file            Existing HTML File id: publish a new version of this artefact.
                    Omit to create a new File; reuse the printed file_id for updates.
  --title           Display name for a new HTML File (default: the document <title>)
  --canvas          Also add a naplet that follows the latest version
  --signer-cli      Capability broker CLI (default: $WINGMAN_CAPABILITY_CLI or
                    $AUTOPILOT_REPO/clis/wingman-capability.ts)

Images become private sibling Files in the same channel; nothing is made public.`;

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) { options._.push(value); continue; }
    const key = value.slice(2);
    if (['dry-run', 'smoke', 'json', 'help'].includes(key)) options[key] = true;
    else options[key] = argv[++index];
  }
  return options;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const log = (options, message) => { if (!options.json) console.error(message); };

async function smoke(packaged, html, options) {
  const { runSandboxSmoke } = await import('./html-artifact/smoke.mjs');
  const result = await runSandboxSmoke({ html, assets: packaged.assets });
  log(options, `Sandbox smoke: ${result.readyImages}/${result.expectedImages} images rendered, ${result.cspViolations.length} CSP violations, ${result.pageErrors.length} script errors`);
  for (const line of [...result.cspViolations, ...result.pageErrors]) log(options, `  ${line}`);
  if (!result.ok) throw new Error('Sandbox smoke test failed; fix the issues above before publishing');
  return result;
}

async function resolveExistingAssets(client, fileId) {
  try {
    const current = await client.readCurrentObject(fileId);
    const html = Buffer.from(current?.object?.base64_data || '', 'base64').toString('utf8');
    return { channelId: current?.file?.channel_id, currentVersionId: current?.file?.current_version_id, manifest: readManifest(html) };
  } catch (error) {
    if (error instanceof TowerError && error.status === 404) throw new Error(`--file ${fileId} is not a readable File in this workspace`);
    throw error;
  }
}

async function publishAsset(client, asset, previous, channelId, artifactTitle, options) {
  if (previous && previous.sha256 === asset.sha256) {
    log(options, `  ${asset.name}: unchanged, reusing ${previous.version_id}`);
    return { name: asset.name, file_id: previous.file_id, version_id: previous.version_id, sha256: asset.sha256, reused: true };
  }
  const objectId = await client.uploadObject({ bytes: asset.bytes, contentType: asset.contentType, fileName: asset.name });
  if (previous) {
    try {
      const versions = await client.listVersions(previous.file_id);
      const result = await client.createVersion(previous.file_id, { base_version_id: versions.current_version_id, storage_object_id: objectId });
      log(options, `  ${asset.name}: new version ${result.version.version_number} of image File ${previous.file_id}`);
      return { name: asset.name, file_id: previous.file_id, version_id: result.version.id, sha256: asset.sha256 };
    } catch (error) {
      if (!(error instanceof TowerError) || ![403, 404].includes(error.status)) throw error;
      log(options, `  ${asset.name}: previous image File unavailable (${error.status}); creating a new one`);
    }
  }
  const created = await client.createFile(channelId, { storage_object_id: objectId, display_name: `${artifactTitle} · ${asset.name}`.slice(0, 200), metadata: { html_artifact_asset: true } });
  const versionId = created.file.current_version_id || (await client.listVersions(created.file.id)).current_version_id;
  log(options, `  ${asset.name}: new private image File ${created.file.id}`);
  return { name: asset.name, file_id: created.file.id, version_id: versionId, sha256: asset.sha256 };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options._.length !== 1) { console.log(USAGE); process.exit(options.help ? 0 : 2); }
  const folder = path.resolve(options._[0]);
  const packaged = await packageArtifactFolder(folder, { entry: options.entry || 'index.html' });
  for (const warning of packaged.warnings) log(options, `warning: ${warning}`);
  const total = packaged.assets.reduce((sum, asset) => sum + asset.size, 0);
  log(options, `Packaged "${packaged.title}": ${Buffer.byteLength(packaged.html)} bytes of HTML, ${packaged.assets.length} images (${total} bytes)`);

  if (options['dry-run']) {
    const placeholder = packaged.assets.map(asset => ({ name: asset.name, file_id: '00000000-0000-4000-8000-000000000000', version_id: '00000000-0000-4000-8000-000000000000', sha256: asset.sha256 }));
    const html = withManifest(packaged.html, placeholder);
    const smokeResult = options.smoke ? await smoke(packaged, html, options) : null;
    if (options.out) {
      const out = path.resolve(options.out);
      await mkdir(path.join(out, 'assets'), { recursive: true });
      await writeFile(path.join(out, 'index.html'), html);
      for (const asset of packaged.assets) await copyFile(asset.path, path.join(out, 'assets', asset.name));
      await writeFile(path.join(out, 'preview.html'), previewHtml(html, packaged.assets.map(asset => ({ ...asset, relative: `assets/${asset.name}` }))));
      log(options, `Wrote ${out}/index.html, preview.html and assets/`);
    }
    const summary = { dry_run: true, title: packaged.title, html_bytes: Buffer.byteLength(html), assets: packaged.assets.map(({ name, size, contentType, sha256 }) => ({ name, size_bytes: size, content_type: contentType, sha256 })), warnings: packaged.warnings, smoke: smokeResult };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const tower = options.tower || process.env.WINGMAN_TOWER_URL;
  const workspaceId = options.workspace;
  let channelId = options.channel;
  if (!tower || !uuid.test(String(workspaceId || ''))) throw new Error('--tower and --workspace are required (use --dry-run to package only)');
  if (options.file && !uuid.test(options.file)) throw new Error('--file must be a File UUID');
  if (options.canvas && !uuid.test(options.canvas)) throw new Error('--canvas must be a Canvas UUID');
  const client = towerClient({ baseUrl: tower, workspaceId, sign: brokerSigner({ cli: options['signer-cli'] || defaultSignerCli() }) });

  const existing = options.file ? await resolveExistingAssets(client, options.file) : null;
  if (existing && channelId && existing.channelId && channelId !== existing.channelId) throw new Error(`--channel does not match the File's channel ${existing.channelId}`);
  channelId = channelId || existing?.channelId;
  if (!uuid.test(String(channelId || ''))) throw new Error('--channel is required for a new artefact');
  if (options.smoke) await smoke(packaged, withManifest(packaged.html, []), options);

  log(options, `Uploading ${packaged.assets.length} private images to channel ${channelId}`);
  const previousByName = new Map((existing?.manifest || []).map(row => [row.name, row]));
  const entries = [];
  for (const asset of packaged.assets) entries.push(await publishAsset(client, asset, previousByName.get(asset.name), channelId, options.title || packaged.title, options));
  const html = withManifest(packaged.html, entries);
  const htmlBytes = Buffer.from(html);
  const objectId = await client.uploadObject({ bytes: htmlBytes, contentType: 'text/html', fileName: 'index.html' });
  let fileId, version;
  if (options.file) {
    try {
      const result = await client.createVersion(options.file, { base_version_id: existing.currentVersionId, storage_object_id: objectId });
      fileId = options.file; version = result.version;
    } catch (error) {
      if (error instanceof TowerError && error.status === 409) throw new Error('Another version was published while this one was being prepared (stale base_version_id). Re-run to publish on top of the latest version.');
      throw error;
    }
  } else {
    const created = await client.createFile(channelId, { storage_object_id: objectId, display_name: (options.title || packaged.title).slice(0, 200), metadata: { html_artifact: true } });
    fileId = created.file.id;
    const versions = await client.listVersions(fileId);
    version = versions.versions.find(row => row.id === versions.current_version_id);
  }
  let naplet = null;
  if (options.canvas) {
    const created = await client.addNaplet(options.canvas, { source: { type: 'html', id: fileId }, title: (options.title || packaged.title).slice(0, 200), layout: { x: Number(options.x || 80), y: Number(options.y || 80), width: Number(options.width || 720), height: Number(options.height || 640), z: 1 } });
    naplet = { id: created.naplet.id, access: created.naplet.access };
  }
  const summary = {
    file_id: fileId, version_id: version?.id, version_number: version?.version_number, channel_id: channelId,
    assets: entries, naplet,
    update_command: `bun scripts/publish-html-artifact.mjs ${JSON.stringify(options._[0])} --tower ${tower} --workspace ${workspaceId} --file ${fileId}`,
  };
  log(options, `Published version ${version?.version_number} of File ${fileId}`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error(error instanceof ArtifactPackageError ? error.message : `error: ${error.message}`);
  process.exit(1);
});
