import { buildCanvasHtmlDocument, CANVAS_HTML_ASSET_MESSAGE } from './sandbox.js';

const BLOCKED_DOCUMENT = buildCanvasHtmlDocument('<p style="padding:16px;color:#5b6474">This artefact tried to navigate away and was stopped. Refresh the canvas to reload it.</p>');

function nonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Owns one sandboxed HTML iframe. The host accepts only `:ready`/`:unload`
 * notices whose source is this exact contentWindow and whose nonce belongs to
 * the generated document. It then posts verified image Blobs once, to that
 * window only. An unload before the next generated document means the artefact
 * navigated itself: the frame is replaced and receives nothing further.
 */
export function registerCanvasHtml(Alpine, { assetStore }) {
  Alpine.directive('canvas-html', (iframe, { expression }, { evaluateLater, effect, cleanup }) => {
    const evaluate = evaluateLater(expression);
    let signature = '', token = 0, state = 'idle', assets = [], documentNonce = '';
    const deliver = async generation => {
      const store = assetStore();
      const batch = store ? await store.resolve(assets) : [];
      if (generation !== token || state !== 'live' || !iframe.contentWindow) return;
      // Re-check after the async fetch: anything dropped meanwhile stays out.
      const deliverable = new Set(assets.filter(asset => asset.status === 'ready').map(asset => asset.name));
      const permitted = batch.filter(row => deliverable.has(row.name) && (!store?.allowed || store.allowed.has(store.key(assets.find(asset => asset.name === row.name)))));
      iframe.dataset.assetsDelivered = String(permitted.length);
      iframe.contentWindow.postMessage({ type: CANVAS_HTML_ASSET_MESSAGE, nonce: documentNonce, assets: permitted }, '*');
    };
    const onMessage = event => {
      if (!documentNonce || !event.data || event.data.nonce !== documentNonce) return;
      // Chrome delivers the outgoing document's unload notice with a null
      // (detached) source. Accepting it only ever blocks delivery.
      const fromFrame = event.source === iframe.contentWindow;
      if (!fromFrame && !(event.source === null && event.data.type === `${CANVAS_HTML_ASSET_MESSAGE}:unload`)) return;
      if (event.data.type === `${CANVAS_HTML_ASSET_MESSAGE}:ready` && state === 'awaiting' && fromFrame) {
        state = 'live';
        void deliver(token);
      } else if (event.data.type === `${CANVAS_HTML_ASSET_MESSAGE}:unload` && state !== 'blocked') {
        state = 'blocked'; token += 1; documentNonce = '';
        iframe.dataset.navigationBlocked = 'true';
        iframe.srcdoc = BLOCKED_DOCUMENT;
      }
    };
    addEventListener('message', onMessage);
    effect(() => evaluate(value => {
      const content = value && typeof value === 'object' ? value : {};
      // Assets are part of the identity: losing (or gaining) access to one
      // image replaces the document so already-delivered blob URLs are gone.
      const assetSignature = (Array.isArray(content.assets) ? content.assets : [])
        .map(asset => asset.status === 'ready' ? `${asset.name}=${asset.file_id}/${asset.version_id}/${asset.sha256}` : `${asset.name}=-`).join(',');
      const next = `${content.version_id || ''}:${content.digest || ''}:${(content.html || '').length}:${assetSignature}`;
      if (next === signature) return;
      signature = next; token += 1; state = 'awaiting';
      assets = Array.isArray(content.assets) ? content.assets : [];
      // A fresh nonce makes the outgoing document's unload notice stale.
      documentNonce = nonce();
      delete iframe.dataset.navigationBlocked;
      delete iframe.dataset.assetsDelivered;
      iframe.srcdoc = buildCanvasHtmlDocument(content.html, { nonce: documentNonce, hostOrigin: location.origin });
    }));
    cleanup(() => {
      token += 1; state = 'idle'; documentNonce = '';
      removeEventListener('message', onMessage);
    });
  });
}
