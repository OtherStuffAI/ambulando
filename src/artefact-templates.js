// Maintained starter assets. IDs are allowlisted; no remote template installation.
import { createEmptyBoardScene } from './canvas/board-scene.js';

export const TEMPLATE_CONTRACT_VERSION = 1;
export const ARTEFACT_STYLES = Object.freeze({
  default: Object.freeze({ label: 'Ambulando', background: '#faf8fc', ink: '#2b1b3c', accent: '#70509a' }),
  paper: Object.freeze({ label: 'Paper', background: '#ffffff', ink: '#202124', accent: '#35655c' }),
});
export const ARTEFACT_TEMPLATES = Object.freeze([
  Object.freeze({ id: 'blank', type: 'document', label: 'Blank document' }),
  Object.freeze({ id: 'brief', type: 'document', label: 'Working brief' }),
  Object.freeze({ id: 'blank', type: 'excalidraw', label: 'Whiteboard' }),
  Object.freeze({ id: 'explorer', type: 'html', label: 'Interactive explorer' }),
  Object.freeze({ id: 'system', type: 'system-flow', label: 'System Flow (web editor)' }),
]);
export function templateDescriptor(type, templateId, styleId = 'default') {
  if (!ARTEFACT_TEMPLATES.some(t => t.type === type && t.id === templateId) || !Object.hasOwn(ARTEFACT_STYLES, styleId)) throw Error('Unsupported controlled template or style.');
  return { schema_version: 1, type, format_version: 1, editor_id: `builtin.${type}`, template_id: templateId, template_version: TEMPLATE_CONTRACT_VERSION, style_id: styleId, style_version: 1 };
}
const escapeMarkup = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function templateSource(type, templateId, styleId = 'default', title = 'Explore an idea') {
  templateDescriptor(type, templateId, styleId);
  const style = ARTEFACT_STYLES[styleId];
  if (type === 'system-flow') return { schemaVersion: 1, title, nodes: [{ id: 'start', type: 'flow', position: { x: 0, y: 0 }, data: { kind: 'view', label: 'Start', owner: '' } }, { id: 'action', type: 'flow', position: { x: 300, y: 0 }, data: { kind: 'action', label: 'Take action', owner: '' } }], edges: [{ id: 'start-action', source: 'start', target: 'action', type: 'smoothstep', relationship: 'flow', label: 'Continue' }] };
  if (type === 'document') return templateId === 'brief' ? '# Purpose\n\nDescribe the progress this work should make.\n\n## Evidence\n\nRecord the facts and source links.\n\n## Decisions\n\nExplain the choices and open questions.\n\n## Next steps\n\n- Define the next action and owner.\n' : '';
  if (type === 'excalidraw') return { ...createEmptyBoardScene(), appState: { viewBackgroundColor: style.background } };
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeMarkup(title)}</title><style>${templateCSS(styleId)}</style></head><body><main><h1>${escapeMarkup(title)}</h1><p>Change the value to explore a scenario. Edit the source to develop your idea.</p><label>Progress <input id="progress" type="range" min="0" max="100" value="30"></label><output id="result">30%</output><p>Controls change this view. Save source changes as a new artefact version.</p></main><script>document.getElementById('progress').addEventListener('input',event=>{document.getElementById('result').textContent=event.target.value+'%';});</script></body></html>`;
}
export function templateCSS(styleId = 'default') {
  if (!Object.hasOwn(ARTEFACT_STYLES, styleId)) throw Error('Unsupported controlled style.');
  const s = ARTEFACT_STYLES[styleId];
  return `:root{color-scheme:light;--paper:${s.background};--ink:${s.ink};--accent:${s.accent}}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 system-ui,sans-serif}main{max-width:72rem;margin:auto;padding:clamp(1rem,4vw,3rem)}h1{line-height:1.15}button,input,select,textarea{font:inherit}button{cursor:pointer;min-height:44px}button:disabled{cursor:default}input,select,textarea,button{border:1px solid var(--accent);border-radius:6px;padding:.5rem;color:var(--ink);background:var(--paper)}:focus-visible{outline:3px solid var(--accent);outline-offset:2px}label{display:block;margin:.5rem 0}output{display:block;font-size:2rem;color:var(--accent)}`;
}
