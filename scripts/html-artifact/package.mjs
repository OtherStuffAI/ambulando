// Packages a local HTML artefact folder for private publication to Tower.
// Pure Node/Bun module: no network, no DOM, no signing. See
// docs/html-artifact-publishing.md for the contract.
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const LIMITS = Object.freeze({
  htmlBytes: 2 * 1024 * 1024,
  assetBytes: 8 * 1024 * 1024,
  totalAssetBytes: 32 * 1024 * 1024,
  assets: 64,
  inlineCssImageBytes: 256 * 1024,
});
export const MANIFEST_ID = 'wingman-artifact-assets';
export const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const IMAGE_TYPES = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
});
const MAGIC = Object.freeze({
  'image/png': bytes => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
  'image/jpeg': bytes => bytes[0] === 0xff && bytes[1] === 0xd8,
  'image/gif': bytes => bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46,
  'image/webp': bytes => String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP',
});

export class ArtifactPackageError extends Error {
  constructor(problems) {
    super(`Artefact cannot be packaged:\n${problems.map(problem => `  - ${problem}`).join('\n')}`);
    this.name = 'ArtifactPackageError';
    this.problems = problems;
  }
}

export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
const isRemote = value => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value) || /^(?:https?|ftp|ws|wss):/i.test(value);
const isInline = value => /^(?:data|blob):/i.test(value);
const isFragment = value => value.startsWith('#');
const isOtherScheme = value => /^[a-z][a-z0-9+.-]*:/i.test(value);
const decodeEntities = value => String(value).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

function parseAttributes(source) {
  const attributes = [];
  const pattern = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(source))) attributes.push({ name: match[1].toLowerCase(), raw: match[1], value: decodeEntities(match[2] ?? match[3] ?? match[4] ?? '') });
  return attributes;
}
const attribute = (attributes, name) => attributes.find(row => row.name === name)?.value;
const escapeAttribute = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
function serializeTag(name, attributes, selfClosing = false) {
  const rendered = attributes.map(row => row.value === '' && row.bare ? ` ${row.raw}` : ` ${row.raw}="${escapeAttribute(row.value)}"`).join('');
  return `<${name}${rendered}${selfClosing ? ' /' : ''}>`;
}

/** Resolve a reference inside the artefact folder, refusing escapes and symlinks out. */
async function resolveLocal(root, fromFile, reference) {
  const clean = decodeURIComponent(reference.split(/[?#]/)[0]);
  if (!clean || path.isAbsolute(clean) || clean.startsWith('/')) return { error: `absolute path "${reference}" is not supported; use a path relative to the artefact folder` };
  const target = path.resolve(path.dirname(fromFile), clean);
  let real;
  try { real = await realpath(target); } catch { return { error: `"${reference}" does not exist` }; }
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) return { error: `"${reference}" resolves outside the artefact folder` };
  const info = await stat(real);
  if (!info.isFile()) return { error: `"${reference}" is not a file` };
  return { path: real, relative: path.relative(root, real).split(path.sep).join('/') };
}

function assetNameFor(relative, taken) {
  const base = path.posix.basename(relative).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'asset';
  const candidates = [base, relative.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '')];
  for (const candidate of candidates) {
    const name = candidate.slice(-128).replace(/^[^A-Za-z0-9]+/, '');
    if (ASSET_NAME.test(name) && !taken.has(name)) return name;
  }
  for (let index = 2; ; index += 1) {
    const extension = path.posix.extname(base), stem = base.slice(0, base.length - extension.length).slice(0, 100);
    const name = `${stem}-${index}${extension}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * Package `<folder>/<entry>` into one HTML document plus private image assets.
 * Returns { html, title, assets, warnings }; throws ArtifactPackageError with
 * every problem found when the folder uses unsupported features.
 */
export async function packageArtifactFolder(folder, { entry = 'index.html' } = {}) {
  const root = await realpath(path.resolve(folder));
  const errors = [], warnings = [];
  const entryResolved = await resolveLocal(root, path.join(root, 'index.html'), entry);
  if (entryResolved.error) throw new ArtifactPackageError([`entry ${entryResolved.error}`]);
  const entryPath = entryResolved.path;
  let html = await readFile(entryPath, 'utf8');
  const assets = new Map(); // relative path -> asset
  const names = new Set();
  const warnOnce = new Set();
  const warn = message => { if (!warnOnce.has(message)) { warnOnce.add(message); warnings.push(message); } };

  async function addImage(reference, fromFile, context) {
    const local = await resolveLocal(root, fromFile, reference);
    if (local.error) { errors.push(`${context}: ${local.error}`); return null; }
    const contentType = IMAGE_TYPES[path.extname(local.path).toLowerCase()];
    if (!contentType) { errors.push(`${context}: "${reference}" is not a supported image (png, jpeg, gif, webp, avif, svg)`); return null; }
    if (assets.has(local.relative)) return assets.get(local.relative);
    const bytes = new Uint8Array(await readFile(local.path));
    if (MAGIC[contentType] && !MAGIC[contentType](bytes)) { errors.push(`${context}: "${reference}" content does not match its ${contentType} extension`); return null; }
    if (bytes.byteLength > LIMITS.assetBytes) { errors.push(`${context}: "${reference}" is ${bytes.byteLength} bytes; the per-image limit is ${LIMITS.assetBytes} (recompress to WebP/JPEG)`); return null; }
    const name = assetNameFor(local.relative, names);
    names.add(name);
    const asset = { name, path: local.path, relative: local.relative, bytes, contentType, size: bytes.byteLength, sha256: sha256Hex(bytes) };
    assets.set(local.relative, asset);
    return asset;
  }

  async function processCss(css, fromFile, context) {
    if (/@import\b/i.test(css)) errors.push(`${context}: @import is not supported; link each local stylesheet directly`);
    let output = '';
    let last = 0;
    for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) {
      const reference = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      output += css.slice(last, match.index);
      last = match.index + match[0].length;
      if (!reference || isInline(reference) || isFragment(reference)) { output += match[0]; continue; }
      if (isRemote(reference) || isOtherScheme(reference)) { errors.push(`${context}: remote CSS resource "${reference}" is not allowed; bundle it locally`); output += match[0]; continue; }
      const local = await resolveLocal(root, fromFile, reference);
      if (local.error) { errors.push(`${context}: ${local.error}`); output += match[0]; continue; }
      const contentType = IMAGE_TYPES[path.extname(local.path).toLowerCase()];
      const bytes = await readFile(local.path);
      if (!contentType || bytes.byteLength > LIMITS.inlineCssImageBytes) {
        errors.push(`${context}: CSS url("${reference}") must be an image of at most ${LIMITS.inlineCssImageBytes} bytes; for larger images use <div data-asset-background="name"> with an <img> asset`);
        output += match[0];
        continue;
      }
      output += `url("data:${contentType};base64,${Buffer.from(bytes).toString('base64')}")`;
    }
    return output + css.slice(last);
  }

  // Inline local stylesheets; reject remote ones; drop hints that would fetch.
  const replacements = [];
  for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attributes = parseAttributes(match[1]);
    const rel = String(attribute(attributes, 'rel') || '').toLowerCase().split(/\s+/);
    const href = String(attribute(attributes, 'href') || '').trim();
    if (rel.includes('stylesheet')) {
      if (!href || isRemote(href) || isOtherScheme(href)) { errors.push(`<link rel="stylesheet" href="${href}">: remote stylesheets and fonts are not allowed; download them into the folder`); continue; }
      const local = await resolveLocal(root, entryPath, href);
      if (local.error) { errors.push(`<link href="${href}">: ${local.error}`); continue; }
      const css = await processCss(await readFile(local.path, 'utf8'), local.path, `stylesheet ${local.relative}`);
      replacements.push([match[0], `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`]);
    } else {
      if (href && (isRemote(href) || isOtherScheme(href))) warn(`<link rel="${rel.join(' ')}" href="${href}"> removed: the canvas sandbox blocks network requests`);
      else warn(`<link rel="${rel.join(' ')}"> removed: only stylesheets are packaged`);
      replacements.push([match[0], '']);
    }
  }
  for (const [from, to] of replacements) html = html.replace(from, () => to);

  // Inline local scripts; reject remote/module imports.
  const scriptReplacements = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = parseAttributes(match[1]);
    const src = String(attribute(attributes, 'src') || '').trim();
    const type = String(attribute(attributes, 'type') || '').toLowerCase();
    let code = match[2];
    if (src) {
      if (isRemote(src) || isOtherScheme(src)) { errors.push(`<script src="${src}">: remote scripts are not allowed; vendor the file into the folder`); continue; }
      const local = await resolveLocal(root, entryPath, src);
      if (local.error) { errors.push(`<script src="${src}">: ${local.error}`); continue; }
      code = await readFile(local.path, 'utf8');
    }
    if (type === 'module' && /\bimport\s*(?:[\w{*][^;]*from\s*)?["'`]|\bimport\s*\(/.test(code)) errors.push(`module script${src ? ` ${src}` : ''}: import statements are not supported; bundle into one script`);
    if (!type || type === 'module' || type.includes('javascript')) {
      if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|navigator\.sendBeacon|new\s+(?:XMLHttpRequest|WebSocket|EventSource)\b/.test(code)) {
        warn(`script${src ? ` ${src}` : ''} uses network APIs; the canvas sandbox blocks them (connect-src 'none'), so inline any data as <script type="application/json">`);
      }
    }
    if (String(attribute(attributes, 'id') || '') === MANIFEST_ID) { scriptReplacements.push([match[0], '']); continue; }
    const kept = attributes.filter(row => !['src', 'integrity', 'crossorigin', 'async', 'defer'].includes(row.name));
    scriptReplacements.push([match[0], `${serializeTag('script', kept)}${code.replace(/<\/script/gi, '<\\/script')}</script>`]);
  }
  for (const [from, to] of scriptReplacements) html = html.replace(from, () => to);

  // Script bodies are opaque to the remaining rewrites (markup inside JS strings
  // must not be altered); they are restored verbatim at the end.
  const maskedScripts = [];
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, whole => `\u0000script-${maskedScripts.push(whole) - 1}\u0000`);

  // Inline <style> blocks and style attributes.
  const styleBlocks = [];
  for (const match of html.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi)) {
    styleBlocks.push([match[0], `<style${match[1]}>${await processCss(match[2], entryPath, 'inline <style>')}</style>`]);
  }
  for (const [from, to] of styleBlocks) html = html.replace(from, () => to);

  // Rewrite element references.
  const tagReplacements = [];
  for (const match of html.matchAll(/<(img|image|source|video|audio|iframe|object|embed|a|form)\b([^>]*?)(\/?)>/gi)) {
    const tag = match[1].toLowerCase();
    const attributes = parseAttributes(match[2]);
    const label = `<${tag}>`;
    const style = attribute(attributes, 'style');
    if (style && /url\(/i.test(style)) {
      const row = attributes.find(item => item.name === 'style');
      row.value = await processCss(style, entryPath, `${label} style`);
    }
    if (tag === 'img' || tag === 'image') {
      const sourceName = tag === 'img' ? 'src' : (attribute(attributes, 'href') !== undefined ? 'href' : 'xlink:href');
      const src = String(attribute(attributes, sourceName) || '').trim();
      if (attribute(attributes, 'srcset') !== undefined) errors.push(`${label} srcset is not supported; use a single src image`);
      if (src && !isInline(src)) {
        if (isRemote(src) || isOtherScheme(src)) errors.push(`${label} src="${src}": remote images are not allowed; save the image into the folder`);
        else {
          const asset = await addImage(src, entryPath, `${label} src`);
          if (asset) {
            const kept = attributes.filter(row => row.name !== sourceName && row.name !== 'data-asset' && row.name !== 'loading');
            kept.push({ name: 'data-asset', raw: 'data-asset', value: asset.name });
            tagReplacements.push([match[0], serializeTag(match[1], kept, match[3] === '/')]);
            continue;
          }
        }
      }
    } else if (['source', 'video', 'audio', 'iframe', 'object', 'embed'].includes(tag)) {
      const reference = attribute(attributes, 'src') ?? attribute(attributes, 'srcset') ?? attribute(attributes, 'data');
      if (reference !== undefined && !isInline(String(reference))) errors.push(`${label} with "${reference}" is not supported in canvas artefacts (images only)`);
    } else if (tag === 'a') {
      const href = String(attribute(attributes, 'href') || '').trim();
      if (href && !isFragment(href) && !isRemote(href) && !isOtherScheme(href)) {
        warn('links to local files were removed: navigation is disabled inside canvas naplets (images remain visible inline)');
        const kept = attributes.filter(row => row.name !== 'href' && row.name !== 'download');
        tagReplacements.push([match[0], serializeTag(match[1], kept)]);
        continue;
      }
      if (href && !isFragment(href)) warn('external links are kept but inert: canvas naplets cannot navigate or open windows');
    } else if (tag === 'form') {
      warn('forms are inert inside canvas naplets (form submission is blocked)');
    }
    if (style && /url\(/i.test(style)) tagReplacements.push([match[0], serializeTag(match[1], attributes, match[3] === '/')]);
  }
  for (const [from, to] of tagReplacements) html = html.replace(from, () => to);
  html = html.replace(/\u0000script-(\d+)\u0000/g, (_, index) => maskedScripts[Number(index)]);

  const list = [...assets.values()];
  if (list.length > LIMITS.assets) errors.push(`${list.length} images exceed the ${LIMITS.assets}-image limit`);
  const total = list.reduce((sum, asset) => sum + asset.size, 0);
  if (total > LIMITS.totalAssetBytes) errors.push(`images total ${total} bytes; the per-artefact limit is ${LIMITS.totalAssetBytes} (recompress to WebP/JPEG)`);
  const sizeWithManifest = Buffer.byteLength(withManifest(html, list.map(asset => ({ name: asset.name, file_id: '00000000-0000-4000-8000-000000000000', version_id: '00000000-0000-4000-8000-000000000000', sha256: asset.sha256 }))));
  if (sizeWithManifest > LIMITS.htmlBytes) errors.push(`packaged HTML is ${sizeWithManifest} bytes; the limit is ${LIMITS.htmlBytes}. Move inline images to files`);
  if (errors.length) throw new ArtifactPackageError(errors);
  const title = decodeEntities(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() || '') || path.basename(root);
  return { html, title, assets: list, warnings, entry: entryResolved.relative };
}

/** Insert (or replace) the exact asset manifest Tower validates. */
export function withManifest(html, entries) {
  const json = JSON.stringify({ version: 1, assets: entries.map(({ name, file_id, version_id, sha256 }) => ({ name, file_id, version_id, sha256 })) })
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const script = `<script type="application/json" id="${MANIFEST_ID}">${json}</script>`;
  const cleaned = String(html).replace(new RegExp(`<script\\b[^>]*\\bid\\s*=\\s*["']${MANIFEST_ID}["'][^>]*>[\\s\\S]*?<\\/script\\s*>`, 'gi'), '');
  return /<\/body\s*>/i.test(cleaned) ? cleaned.replace(/<\/body\s*>(?![\s\S]*<\/body)/i, `${script}</body>`) : `${cleaned}${script}`;
}

/** Read a manifest from previously published HTML (used to reuse asset Files). */
export function readManifest(html) {
  const match = new RegExp(`<script\\b[^>]*\\bid\\s*=\\s*["']${MANIFEST_ID}["'][^>]*>([\\s\\S]*?)<\\/script\\s*>`, 'i').exec(String(html || ''));
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed?.assets) ? parsed.assets.filter(row => row && ASSET_NAME.test(String(row.name))) : [];
  } catch {
    return [];
  }
}

/** A plain-browser preview with relative image paths, for local review only. */
export function previewHtml(html, assets) {
  const byName = new Map(assets.map(asset => [asset.name, asset.relative]));
  return String(html).replace(/(<(?:img|image)\b[^>]*?)\sdata-asset="([^"]+)"/gi, (whole, start, name) => byName.has(name) ? `${start} src="${escapeAttribute(byName.get(name))}" data-asset="${name}"` : whole);
}
