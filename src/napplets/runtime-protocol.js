// Common cartridge protocol. Legacy File v1/v2 stay independently parsed.
import { canonical, decodeJson, exact, validateJson } from './generic-protocol.js';
export const RUNTIME_VERSION = 3;
export const COLLECTION_OPERATIONS = Object.freeze(['list', 'get', 'create', 'update', 'delete']);
export const PERSONAL_CAPABILITIES = Object.freeze({
  'nostr-dm': Object.freeze(['read', 'decrypt', 'send', 'persist', 'agent']),
});
const name = s => typeof s === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(s);
const recordId = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(s);
const positive = n => Number.isSafeInteger(n) && n > 0;
const safeText = (s, max) => typeof s === 'string' && [...s].length > 0 && [...s].length <= max && !/[\p{Cc}\p{Cs}]/u.test(s);
const unique = a => Array.isArray(a) && a.length <= 64 && new Set(a).size === a.length;
const fail = () => { throw Error('Invalid napplet runtime contract.'); };
export function validateRuntimeManifest(value) {
  validateJson(value);
  if (!exact(value, ['version','napplet_id','bundle_version','title','icon','runtime','collections','capabilities']) || value.version !== 3 || !name(value.napplet_id) || !safeText(value.bundle_version,64) || !safeText(value.title,80) || !safeText(value.icon,8) || /[<>:/\\]/u.test(value.icon)) fail();
  if (!exact(value.runtime,['protocol','min_host']) || value.runtime.protocol !== 3 || !positive(value.runtime.min_host)) fail();
  for (const entries of [value.collections,value.capabilities]) if (!entries || Array.isArray(entries) || typeof entries !== 'object' || Object.keys(entries).length > 32) fail();
  for (const [key,c] of Object.entries(value.collections)) {
    if (!name(key) || !exact(c,['scope','schema_version','operations']) || !['personal','team'].includes(c.scope) || !positive(c.schema_version) || !unique(c.operations) || !c.operations.length || c.operations.some(op => !COLLECTION_OPERATIONS.includes(op))) fail();
  }
  for (const [key,c] of Object.entries(value.capabilities)) {
    if (!name(key) || !exact(c,['version','resources','operations']) || !positive(c.version) || !unique(c.resources) || c.resources.some(r=>!safeText(r,2048)) || !unique(c.operations) || !c.operations.length || c.operations.some(op=>!name(op))) fail();
    if (key==='nostr-dm' && c.version===1 && c.operations.some(op=>!PERSONAL_CAPABILITIES['nostr-dm'].includes(op))) fail();
  }
  return JSON.parse(canonical(value));
}
export function parseRuntimeManifest(html) {
  const matches = [...String(html).matchAll(/<script\b[^>]*[\t\n\f\r ]id\s*=\s*["']wingman-napplet-manifest["'][^>]*>([\s\S]*?)<\/script\s*>/gi)];
  if (matches.length !== 1) fail();
  return validateRuntimeManifest(decodeJson(matches[0][1]));
}
// Schema changes need compatibility review even without a new read/write grant.
export function runtimeAccess(manifest) {
  const m = validateRuntimeManifest(manifest);
  return {collections:m.collections,capabilities:m.capabilities};
}
export function accessExpansion(approved, requested) {
  const changes = [];
  for (const [key,c] of Object.entries(requested.collections)) {
    const old = approved?.collections?.[key];
    if (!old || old.scope !== c.scope || old.schema_version !== c.schema_version || c.operations.some(op=>!old.operations.includes(op))) changes.push(`collection:${key}`);
  }
  for (const [key,c] of Object.entries(requested.capabilities)) {
    const old = approved?.capabilities?.[key];
    if (!old || old.version !== c.version || c.operations.some(op=>!old.operations.includes(op)) || c.resources.some(r=>!old.resources.includes(r))) changes.push(`capability:${key}`);
  }
  return changes;
}
export function runtimeSupport(manifest) {
  const m=validateRuntimeManifest(manifest);
  if (m.runtime.min_host > RUNTIME_VERSION) return 'This napplet requires a newer host runtime.';
  if (Object.keys(m.capabilities).length) return 'This host does not support the requested personal capabilities. Nostr DM read, decrypt, send, plaintext persistence and agent access are separate permissions; none is available through this runtime yet.';
  return '';
}
export function validRuntimeRequest(event, frame, session, manifest) {
  const d=event?.data, common=['type','version','session','requestId','operation'];
  if (!frame || event.source!==frame || event.origin!=='null' || d?.type!=='wingman-napplet-data' || d.version!==3 || d.session!==session || !/^[a-f0-9]{32}$/.test(session) || typeof d.requestId!=='string' || !/^[A-Za-z0-9_-]{1,64}$/.test(d.requestId)) return false;
  if (d.operation==='dirty') return exact(d,[...common,'dirty']) && typeof d.dirty==='boolean';
  const c=manifest.collections[d.collection];
  if (!c || !Object.hasOwn(manifest.collections,d.collection) || !c.operations.includes(d.operation)) return false;
  const keys=[...common,'collection'];
  if (d.operation==='list') return exact(d,[...keys,'limit','cursor']) && Number.isSafeInteger(d.limit) && d.limit>=1 && d.limit<=100 && (d.cursor===null || typeof d.cursor==='string' && d.cursor.length>=1 && d.cursor.length<=2048);
  if (d.operation==='get') return exact(d,[...keys,'record_id']) && recordId(d.record_id);
  if (!['create','update','delete'].includes(d.operation)) return false;
  if (!exact(d,[...keys,'record_id','base_revision',...(d.operation==='delete'?[]:['value'])]) || !recordId(d.record_id) || (d.operation==='create'?d.base_revision!==0:!positive(d.base_revision))) return false;
  try { if(d.operation!=='delete') validateJson(d.value); return true; } catch { return false; }
}
