const fs = require('node:fs/promises');
const path = require('node:path');
// Agent-independent synthetic browser evidence without starting a preview server.
async function serveBuiltFlightDeck(route, dist = process.env.FLIGHTDECK_TEST_DIST || path.resolve(__dirname, '../../../dist')) {
  const url = new URL(route.request().url());
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort();
  if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
  const relative = url.pathname.startsWith('/assets/') ? url.pathname.slice(1) : url.pathname === '/version.json' ? 'version.json' : 'index.html';
  if (relative.includes('..')) return route.abort();
  const mime = relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.json') ? 'application/json' : 'text/html';
  return route.fulfill({ contentType: mime, body: await fs.readFile(path.join(dist, relative)) });
}
module.exports = { serveBuiltFlightDeck };
