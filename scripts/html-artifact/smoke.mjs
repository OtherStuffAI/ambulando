// Renders a packaged artefact with the exact canvas sandbox document builder,
// iframe attributes and asset bridge, then reports CSP violations, script
// errors and images that failed to render. Local only: assets are served from
// memory and no network is reachable from the sandbox.
import { buildCanvasHtmlDocument, CANVAS_HTML_ASSET_MESSAGE } from '../../src/canvas/sandbox.js';

const ORIGIN = 'http://artifact-smoke.invalid';

// `inspect(frame)` may run extra assertions inside the rendered artefact frame;
// its return value is reported as `inspection`.
export async function runSandboxSmoke({ html, assets, screenshot = '', viewport = { width: 1100, height: 900 }, timeoutMs = 15_000, inspect = null }) {
  const { chromium } = await import('playwright');
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const documentHtml = buildCanvasHtmlDocument(html, { nonce, hostOrigin: ORIGIN });
  const literal = value => JSON.stringify(value).replace(/</g, '\\u003c');
  const host = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style>
<iframe sandbox="allow-scripts" credentialless referrerpolicy="no-referrer"></iframe>
<script>
const frame = document.querySelector('iframe'), nonce = ${literal(nonce)}, type = ${literal(CANVAS_HTML_ASSET_MESSAGE)};
const assets = ${literal(assets.map(asset => ({ name: asset.name, type: asset.contentType })))};
addEventListener('message', async event => {
  if (event.source !== frame.contentWindow || event.data?.nonce !== nonce || event.data?.type !== type + ':ready') return;
  const batch = await Promise.all(assets.map(async asset => ({ name: asset.name, blob: new Blob([await (await fetch('/asset/' + encodeURIComponent(asset.name))).arrayBuffer()], { type: asset.type }) })));
  frame.contentWindow.postMessage({ type, nonce, assets: batch }, '*');
  document.body.dataset.delivered = String(batch.length);
});
frame.srcdoc = ${literal(documentHtml)};
</script>`;
  const browser = await chromium.launch();
  const cspViolations = [], pageErrors = [], blockedRequests = [];
  try {
    const page = await browser.newPage({ viewport });
    const byName = new Map(assets.map(asset => [asset.name, asset]));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === ORIGIN && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: host });
      if (url.origin === ORIGIN && url.pathname.startsWith('/asset/')) {
        const asset = byName.get(decodeURIComponent(url.pathname.slice(7)));
        return asset ? route.fulfill({ contentType: asset.contentType, body: Buffer.from(asset.bytes) }) : route.fulfill({ status: 404, body: '' });
      }
      blockedRequests.push(url.href);
      return route.abort();
    });
    page.on('console', message => { if (/Content Security Policy|Refused to/i.test(message.text())) cspViolations.push(message.text().slice(0, 300)); });
    page.on('pageerror', error => pageErrors.push(String(error?.message || error).slice(0, 300)));
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(count => Number(document.body.dataset.delivered) === count, assets.length, { timeout: timeoutMs });
    const frame = page.frames().find(item => item !== page.mainFrame());
    const images = await frame.waitForFunction(() => {
      const nodes = [...document.querySelectorAll('[data-asset]')];
      if (nodes.some(node => !node.dataset.assetState)) return null;
      return Promise.all(nodes.map(node => node.tagName === 'IMG' && !node.complete ? new Promise(resolve => { node.onload = node.onerror = resolve; }) : null))
        .then(() => nodes.map(node => ({ name: node.dataset.asset, state: node.dataset.assetState, width: node.naturalWidth || 0 })));
    }, null, { timeout: timeoutMs }).then(handle => handle.jsonValue());
    const inspection = inspect ? await inspect(frame, page) : null;
    if (screenshot) await page.screenshot({ path: screenshot, fullPage: false });
    const failed = images.filter(image => image.state !== 'ready' || !(image.width > 0));
    return {
      ok: !failed.length && !cspViolations.length && !pageErrors.length,
      expectedImages: images.length,
      readyImages: images.length - failed.length,
      failedImages: failed.map(image => image.name),
      cspViolations,
      pageErrors,
      blockedRequests,
      inspection,
    };
  } finally {
    await browser.close();
  }
}
