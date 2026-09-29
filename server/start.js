import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createHostedSignupHandler, createSiteSigner, SIGNUP_PATH, SITE_NPUB } from './hosted-signup.js';

const dist = resolve(import.meta.dir, '../dist');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
let signup = null;
if (process.env.FLIGHT_DECK_TOWER_PUBLIC_BASE_URL && process.env.FLIGHT_DECK_SITE_ORIGIN) {
  const sign = createSiteSigner(process.env.FLIGHT_DECK_SITE_NSEC, SITE_NPUB);
  signup = createHostedSignupHandler({ towerUrl: process.env.FLIGHT_DECK_TOWER_PUBLIC_BASE_URL, siteOrigin: process.env.FLIGHT_DECK_SITE_ORIGIN, sign });
}

Bun.serve({ hostname: '0.0.0.0', port: Number(process.env.PORT || 8093), async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/healthz') return Response.json({ ok: true, signup_ready: Boolean(signup), site_npub: signup ? SITE_NPUB : null }, { headers: { 'cache-control': 'no-store' } });
  if (url.pathname === SIGNUP_PATH) return signup ? signup(request) : Response.json({ error: 'site_signer_unavailable', code: 'site_signer_unavailable' }, { status: 503 });
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return new Response(null, { status: 400 }); }
  if (pathname.includes('\\') || pathname.split('/').includes('..')) return new Response(null, { status: 404 });
  const asset = resolve(dist, `.${pathname}`);
  if (asset !== dist && !asset.startsWith(`${dist}${sep}`)) return new Response(null, { status: 404 });
  let file;
  try { file = await readFile(asset === dist ? resolve(dist, 'index.html') : asset); }
  catch {
    if (extname(pathname) || pathname.startsWith('/api/')) return new Response(null, { status: 404 });
    try { file = await readFile(resolve(dist, 'index.html')); } catch { return new Response(null, { status: 503 }); }
  }
  return new Response(request.method === 'HEAD' ? null : file, { headers: { 'content-type': types[extname(pathname)] || (extname(pathname) ? 'application/octet-stream' : 'text/html; charset=utf-8') } });
} });
