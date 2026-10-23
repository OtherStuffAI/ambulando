export const CANVAS_HTML_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src data: blob:; frame-src 'none'; child-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

export const CANVAS_HTML_ASSET_MESSAGE = 'wingman-artifact-assets';

// Links and forms never navigate. In-page fragment links scroll locally instead.
const htmlGuard = `<script>(()=>{const stop=e=>{const link=e.target&&e.target.closest&&e.target.closest('a[href],form');if(link){e.preventDefault();e.stopImmediatePropagation();const h=e.type==='click'&&link.getAttribute('href');if(h&&h[0]==='#'&&h.length>1){let t=null;try{t=document.getElementById(decodeURIComponent(h.slice(1)))}catch{}if(t)t.scrollIntoView({block:'start'})}}};addEventListener('click',stop,true);addEventListener('submit',stop,true);window.open=()=>null;try{Object.defineProperty(window,'opener',{value:null})}catch{}})();<\/script>`;

// Embed a value in an inline script without allowing it to close the element.
const scriptLiteral = value => JSON.stringify(String(value)).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

/**
 * Receives private image Blobs from the host. Accepts exactly one batch whose
 * source is the embedding window, whose origin is the host origin and which
 * carries this document's nonce; another naplet (or this artifact) cannot
 * forge it. Blob URLs are created inside the opaque origin, applied to
 * `[data-asset]` / `[data-asset-background]` elements and revoked on unload.
 * The document announces `:ready` and `:unload` to the host origin so the host
 * can deliver once and detect self-navigation.
 */
function assetBridge({ nonce, hostOrigin }) {
  return `<script>(()=>{const N=${scriptLiteral(nonce)},O=${scriptLiteral(hostOrigin)},P=parent,T=${scriptLiteral(CANVAS_HTML_ASSET_MESSAGE)};`
    + `const NAME=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,TYPE=/^image\\/(png|jpeg|gif|webp|avif|svg\\+xml)$/,urls=new Map();let done=false;`
    + `const css=v=>v.replace(/["\\\\\\n\\r]/g,'');`
    + `const apply=root=>{for(const el of (root.querySelectorAll?root.querySelectorAll('[data-asset],[data-asset-background]'):[])){const n=el.getAttribute('data-asset'),b=el.getAttribute('data-asset-background');`
    + `if(n){const u=urls.get(n);if(u){if(el.namespaceURI==='http://www.w3.org/2000/svg')el.setAttribute('href',u);else el.setAttribute('src',u);el.setAttribute('data-asset-state','ready')}else if(done)el.setAttribute('data-asset-state','missing')}`
    + `if(b){const u=urls.get(b);if(u)el.style.backgroundImage='url("'+css(u)+'")'}}};`
    + `Object.defineProperty(window,'wingmanAssets',{value:Object.freeze({url:n=>urls.get(String(n))||null,names:()=>[...urls.keys()]})});`
    + `addEventListener('message',e=>{if(done||e.source!==P||e.origin!==O)return;const d=e.data;`
    + `if(!d||d.type!==T||d.nonce!==N||!Array.isArray(d.assets)||d.assets.length>64)return;done=true;let total=0;`
    + `for(const a of d.assets){if(!a||!NAME.test(String(a.name))||urls.has(a.name)||!(a.blob instanceof Blob)||!TYPE.test(a.blob.type)||a.blob.size>8388608||(total+=a.blob.size)>33554432)continue;urls.set(a.name,URL.createObjectURL(a.blob))}`
    + `apply(document);new MutationObserver(r=>{for(const m of r)for(const n of m.addedNodes)if(n.nodeType===1){apply(n);if(n.matches&&n.matches('[data-asset],[data-asset-background]'))apply(n.parentNode||document)}}).observe(document.documentElement,{childList:true,subtree:true});`
    + `document.dispatchEvent(new CustomEvent('wingman:assets-ready',{detail:{names:[...urls.keys()]}}))});`
    + `const say=k=>{try{P.postMessage({type:T+':'+k,nonce:N},O)}catch{}};`
    + `if(document.readyState==='loading')addEventListener('DOMContentLoaded',()=>say('ready'),{once:true});else say('ready');`
    + `addEventListener('pagehide',()=>{say('unload');for(const u of urls.values())URL.revokeObjectURL(u);urls.clear()})})();<\/script>`;
}

const tagPattern = name => new RegExp(`<${name}\\b([^>]*)>`, 'i');
// Head elements that would navigate, rebase or re-declare the encoding.
const STRIPPED_HEAD = /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?refresh[^>]*>|<meta\b[^>]*\bcharset\b[^>]*>|<base\b[^>]*>/gi;
// Attributes that must not be copied from the artifact's <html>/<body> tags.
const unsafeAttributes = attributes => String(attributes || '').replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

/**
 * Split a complete HTML document into head and body parts so its title, styles,
 * scripts and body attributes survive. Fragments are treated as body content.
 * Uses bounded regular expressions so the host never builds a live DOM for
 * untrusted markup.
 */
export function splitCanvasHtmlDocument(html) {
  const source = String(html || '').replace(/^\uFEFF/, '').replace(/^\s*<!doctype[^>]*>/i, '');
  const headOpen = tagPattern('head').exec(source);
  const bodyOpen = tagPattern('body').exec(source);
  if (!headOpen && !bodyOpen && !/<html\b/i.test(source)) return { htmlAttributes: '', head: '', bodyAttributes: '', body: source };
  const htmlOpen = tagPattern('html').exec(source);
  let head = '';
  if (headOpen) {
    const headEnd = source.search(/<\/head\s*>/i);
    head = source.slice(headOpen.index + headOpen[0].length, headEnd > headOpen.index ? headEnd : (bodyOpen ? bodyOpen.index : source.length));
  }
  let body = '';
  if (bodyOpen) {
    const tail = source.slice(bodyOpen.index + bodyOpen[0].length);
    const bodyEnd = tail.search(/<\/body\s*>/i);
    body = bodyEnd >= 0 ? tail.slice(0, bodyEnd) : tail.replace(/<\/html\s*>\s*$/i, '');
  } else {
    const headEnd = source.search(/<\/head\s*>/i);
    body = source.slice(headEnd >= 0 ? headEnd + 7 : (htmlOpen ? htmlOpen.index + htmlOpen[0].length : 0)).replace(/<\/html\s*>\s*$/i, '');
  }
  return {
    htmlAttributes: unsafeAttributes(htmlOpen?.[1]),
    head: head.replace(STRIPPED_HEAD, ''),
    bodyAttributes: unsafeAttributes(bodyOpen?.[1]),
    body,
  };
}

export function buildCanvasHtmlDocument(html, { nonce = '', hostOrigin = '' } = {}) {
  const parts = splitCanvasHtmlDocument(html);
  const bridge = nonce && hostOrigin ? assetBridge({ nonce, hostOrigin }) : '';
  // Policy, guard and bridge precede all artifact head content; the default
  // style comes first so the artifact's own styles take precedence.
  return `<!doctype html><html${parts.htmlAttributes}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CANVAS_HTML_CSP}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%;font:14px system-ui;color:#172235;background:#fff}*{box-sizing:border-box}</style>${htmlGuard}${bridge}${parts.head}</head><body${parts.bodyAttributes}>${parts.body}</body></html>`;
}
