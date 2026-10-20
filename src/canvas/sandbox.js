export const CANVAS_HTML_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; media-src data: blob:; frame-src 'none'; child-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

const htmlGuard = `<script>(()=>{const stop=e=>{const link=e.target&&e.target.closest&&e.target.closest('a[href],form');if(link){e.preventDefault();e.stopImmediatePropagation();}};addEventListener('click',stop,true);addEventListener('submit',stop,true);window.open=()=>null;try{Object.defineProperty(window,'opener',{value:null})}catch{}})();<\/script>`;

export function buildCanvasHtmlDocument(html) {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CANVAS_HTML_CSP}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%;font:14px system-ui;color:#172235;background:#fff}*{box-sizing:border-box}</style>${htmlGuard}</head><body>${String(html || '')}</body></html>`;
}
