import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createHostedSignupHandler, SIGNUP_PATH, SITE_NPUB, towerSignupUrl } from './hosted-signup.js';
import { createHostedSiteBroker } from './hosted-site-broker.js';

const dist = resolve(import.meta.dir, '../dist');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
let signup = null;
let broker = null;
let configurationError = 'site_broker_not_configured';
if (process.env.FLIGHT_DECK_SITE_CREDENTIAL_FILE && process.env.FLIGHT_DECK_TOWER_PUBLIC_BASE_URL) {
  try {
    broker = createHostedSiteBroker({ baseUrl: process.env.FLIGHT_DECK_SITE_BROKER_URL,
      credentialFile: process.env.FLIGHT_DECK_SITE_CREDENTIAL_FILE, appId: process.env.APP_ID,
      siteNpub: SITE_NPUB, target: towerSignupUrl(process.env.FLIGHT_DECK_TOWER_PUBLIC_BASE_URL) });
    signup = createHostedSignupHandler({ towerUrl: process.env.FLIGHT_DECK_TOWER_PUBLIC_BASE_URL, sign: broker.sign });
    configurationError = null;
  } catch {
    configurationError = 'site_broker_configuration_invalid';
  }
}
async function readiness() {
  try {
    if (!broker || !signup) return { ready: false, error: configurationError };
    await broker.readiness();
    return { ready: true, error: null };
  } catch { return { ready: false, error: 'site_broker_unavailable' }; }
}

function cacheControl(pathname) {
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (pathname === '/version.json') return 'no-store';
  if (pathname === '/service-worker.js' || pathname === '/index.html') return 'no-cache, must-revalidate';
  return null;
}

Bun.serve({ hostname: '0.0.0.0', port: Number(process.env.PORT || 8093), async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/healthz' || (url.pathname === '/api/hosted/config' && request.method === 'GET')) {
    const state = await readiness();
    return Response.json(url.pathname === '/healthz'
      ? { ok: true, signup_ready: state.ready, site_npub: state.ready ? SITE_NPUB : null, signup_error: state.error }
      : { signup_ready: state.ready, tower_public_base_url: state.ready ? new URL(towerSignupUrl(process.env.FLIGHT_DECK_TOWER_PUBLIC_BASE_URL)).origin + '/' : null, signup_error: state.error },
    { headers: { 'cache-control': 'no-store' } });
  }
  if (url.pathname === SIGNUP_PATH) return (await readiness()).ready ? signup(request) : Response.json({ error: 'site_signer_unavailable', code: 'site_signer_unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return new Response(null, { status: 400 }); }
  if (pathname.includes('\\') || pathname.split('/').includes('..')) return new Response(null, { status: 404 });
  const asset = resolve(dist, `.${pathname}`);
  if (asset !== dist && !asset.startsWith(`${dist}${sep}`)) return new Response(null, { status: 404 });
  let file;
  let servedPath = asset === dist ? '/index.html' : pathname;
  try { file = await readFile(asset === dist ? resolve(dist, 'index.html') : asset); }
  catch {
    if (extname(pathname) || pathname.startsWith('/api/')) return new Response(null, { status: 404 });
    try { file = await readFile(resolve(dist, 'index.html')); } catch { return new Response(null, { status: 503 }); }
    servedPath = '/index.html';
  }
  const headers = { 'content-type': types[extname(servedPath)] || (extname(servedPath) ? 'application/octet-stream' : 'text/html; charset=utf-8') };
  const cache = cacheControl(servedPath);
  if (cache) headers['cache-control'] = cache;
  return new Response(request.method === 'HEAD' ? null : file, { headers });
} });
