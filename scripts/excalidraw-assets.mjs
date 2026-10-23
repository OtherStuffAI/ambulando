import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const PUBLIC_PREFIX = '/excalidraw-assets/';
const FONT_TYPES = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full, base) : [path.relative(base, full)];
  });
}

/**
 * Self-hosts Excalidraw's font files at /excalidraw-assets/fonts/ so board
 * editing never fetches fonts from a third-party CDN. The editor sets
 * `window.EXCALIDRAW_ASSET_PATH` to this prefix.
 */
export function excalidrawAssetPlugin() {
  let root = process.cwd();
  const sourceDir = () => path.join(root, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod');
  return {
    name: 'excalidraw-assets',
    configResolved(config) { root = config.root; },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = decodeURIComponent(String(request.url || '').split('?')[0]);
        if (!pathname.startsWith(`${PUBLIC_PREFIX}fonts/`)) return next();
        const relative = path.normalize(pathname.slice(PUBLIC_PREFIX.length));
        const file = path.join(sourceDir(), relative);
        if (relative.startsWith('..') || !file.startsWith(sourceDir()) || !existsSync(file)) { response.statusCode = 404; return response.end(); }
        response.setHeader('Content-Type', FONT_TYPES[path.extname(file)] || 'application/octet-stream');
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        createReadStream(file).pipe(response);
      });
    },
    generateBundle() {
      const fontsDir = path.join(sourceDir(), 'fonts');
      if (!existsSync(fontsDir)) throw new Error('Excalidraw fonts are missing; run bun install.');
      for (const relative of walk(fontsDir)) {
        if (!FONT_TYPES[path.extname(relative)]) continue;
        this.emitFile({ type: 'asset', fileName: `excalidraw-assets/fonts/${relative.split(path.sep).join('/')}`, source: readFileSync(path.join(fontsDir, relative)) });
      }
    },
  };
}
