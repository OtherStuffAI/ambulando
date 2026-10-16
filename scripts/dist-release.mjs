import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

const ASSET_REFERENCE_PATTERN = /\/assets\/([^"'`\s?#)]+)/g;
const RELATIVE_ASSET_REFERENCE_PATTERN = /["'`]((?:\.\.?\/|assets\/)[^"'`\s?#)]+)(?:[?#][^"'`]*)?["'`]/g;

function listFiles(rootDir, relativeDir = '') {
  const currentDir = path.join(rootDir, relativeDir);
  if (!existsSync(currentDir)) return [];

  return readdirSync(currentDir).flatMap((name) => {
    const relativePath = path.join(relativeDir, name);
    const absolutePath = path.join(rootDir, relativePath);
    return statSync(absolutePath).isDirectory()
      ? listFiles(rootDir, relativePath)
      : [relativePath];
  });
}

function referencedAssets(source, fromAsset = null) {
  const assets = [...source.matchAll(ASSET_REFERENCE_PATTERN)].map((match) => match[1]);
  if (fromAsset !== null) {
    for (const [, reference] of source.matchAll(RELATIVE_ASSET_REFERENCE_PATTERN)) {
      // Vite emits both relative imports and root-relative preload maps. Follow
      // their complete closure so a warm tab can still lazily open an editor.
      const asset = reference.startsWith('assets/') ? reference.slice(7)
        : path.posix.normalize(path.posix.join(path.posix.dirname(fromAsset), reference));
      if (!asset.startsWith('../') && !path.posix.isAbsolute(asset)) assets.push(asset);
    }
  }
  // Ignore route patterns and diagnostic regexes which mention /assets/ but
  // are not file references. Only literal filenames belong to the graph.
  return assets.filter((asset) => /^[A-Za-z0-9_./-]+\.[A-Za-z0-9]+$/.test(asset)
    && !asset.startsWith('../') && !path.posix.isAbsolute(asset));
}

export function collectCurrentAssetClosure(distDir) {
  const indexPath = path.join(distDir, 'index.html');
  if (!existsSync(indexPath)) return new Set();

  const pending = referencedAssets(readFileSync(indexPath, 'utf8'));
  const closure = new Set();
  while (pending.length > 0) {
    const asset = pending.pop();
    if (!asset || closure.has(asset)) continue;
    closure.add(asset);

    const assetPath = path.join(distDir, 'assets', asset);
    if (!existsSync(assetPath)) continue;
    for (const nestedAsset of referencedAssets(readFileSync(assetPath, 'utf8'), asset)) {
      if (!closure.has(nestedAsset)) pending.push(nestedAsset);
    }
  }
  return closure;
}

function copyAtomically(sourcePath, targetPath) {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.next-${process.pid}`;
  copyFileSync(sourcePath, temporaryPath);
  renameSync(temporaryPath, targetPath);
}

export function publishStagedDist(stagingDir, distDir, { onBeforeIndexPublish } = {}) {
  const stagedIndexPath = path.join(stagingDir, 'index.html');
  if (!existsSync(stagedIndexPath)) {
    throw new Error(`Staged build is missing ${stagedIndexPath}`);
  }

  const previousAssets = collectCurrentAssetClosure(distDir);
  const stagedFiles = listFiles(stagingDir);
  const stagedAssets = new Set(
    stagedFiles
      .filter((relativePath) => relativePath.startsWith(`assets${path.sep}`))
      .map((relativePath) => relativePath.slice(`assets${path.sep}`.length)),
  );

  mkdirSync(distDir, { recursive: true });
  for (const relativePath of stagedFiles) {
    if (relativePath === 'index.html') continue;
    copyAtomically(path.join(stagingDir, relativePath), path.join(distDir, relativePath));
  }

  onBeforeIndexPublish?.();
  copyAtomically(stagedIndexPath, path.join(distDir, 'index.html'));

  const assetsDir = path.join(distDir, 'assets');
  for (const relativePath of listFiles(assetsDir)) {
    if (!stagedAssets.has(relativePath) && !previousAssets.has(relativePath)) {
      rmSync(path.join(assetsDir, relativePath));
    }
  }

  return {
    publishedFiles: stagedFiles.length,
    retainedPreviousAssets: [...previousAssets].filter((asset) => !stagedAssets.has(asset)),
  };
}
