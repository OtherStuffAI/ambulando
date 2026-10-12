import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectCurrentAssetClosure } from './dist-release.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function verifyDistAssets(distDir = path.join(rootDir, 'dist')) {
  const indexPath = path.join(distDir, 'index.html');
  const failures = [];
  const fail = (message) => failures.push(message);

  if (!existsSync(indexPath)) {
    fail(`${path.basename(distDir)}/index.html is missing. Run bun run build before deploying.`);
    throw new Error(failures.join('\n'));
  }

  const html = readFileSync(indexPath, 'utf8');
  const assetRefs = new Set();
  const assetPattern = /\b(?:src|href)=["']\/assets\/([^"']+)["']/g;
  for (const match of html.matchAll(assetPattern)) {
    assetRefs.add(match[1]);
  }

  if (assetRefs.size === 0) {
    fail('dist/index.html does not reference any /assets/ files.');
  }

  const requiredHtmlSnippets = [
    {
      label: 'chat Get it done action',
      snippet: 'data-chat-get-it-done="true"',
    },
    {
      label: 'chat Get it done modal',
      snippet: 'data-testid="chat-get-it-done-modal"',
    },
  ];
  for (const { label, snippet } of requiredHtmlSnippets) {
    if (!html.includes(snippet)) {
      fail(`dist/index.html is missing ${label}.`);
    }
  }

  for (const assetRef of collectCurrentAssetClosure(distDir)) {
    const assetPath = path.join(distDir, 'assets', assetRef);
    if (!existsSync(assetPath)) {
      fail(`dist application graph references missing asset /assets/${assetRef}.`);
      continue;
    }
    if (statSync(assetPath).size <= 0) {
      fail(`dist application graph references empty asset /assets/${assetRef}.`);
    }
  }

  for (const required of ['version.json', 'service-worker.js']) {
    const requiredPath = path.join(distDir, required);
    if (!existsSync(requiredPath)) {
      fail(`dist/${required} is missing.`);
    }
  }

  if (failures.length > 0) {
    throw new Error(failures.join('\n'));
  }

  return { assetRefs: [...assetRefs] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const distDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(rootDir, 'dist');
  try {
    const result = verifyDistAssets(distDir);
    console.log(`[verify-dist-assets] verified ${result.assetRefs.length} asset reference(s).`);
  } catch (error) {
    console.error(`[verify-dist-assets] ${error.message}`);
    process.exitCode = 1;
  }
}
