export function validOrgDataRequest(event, frame, session) {
  const d = event?.data;
  if (!frame || event.source !== frame || event.origin !== 'null' || !d || typeof d !== 'object' || Array.isArray(d) || d.version !== 1 || d.session !== session) return false;
  const keys = Object.keys(d).sort().join(',');
  if (['ready','refresh','close'].includes(d.type)) return keys === 'session,type,version';
  if (d.type === 'view') return keys === 'session,type,version,view' && ['catalogue','people','chart','holidays'].includes(d.view);
  if (d.type === 'dirty') return keys === 'dirty,session,type,version' && typeof d.dirty === 'boolean';
  if (['profile','dm'].includes(d.type)) return keys === 'id,session,type,version' && typeof d.id === 'string';
  if (d.type === 'bundle') return keys === 'key,session,type,version' && typeof d.key === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(d.key);
  if (d.type !== 'write' || keys !== 'body,method,path,session,type,version') return false;
  return ['POST','PATCH','DELETE'].includes(d.method) && typeof d.path === 'string' && /^(napplets\/bundles|napplets\/installations\/[a-z][a-z0-9_]{0,63}|bootstrap|types|types\/[a-z][a-z0-9_]{0,63}(\/records(\/[0-9a-f-]{36})?)?)$/.test(d.path)
    && d.body && typeof d.body === 'object' && !Array.isArray(d.body) && new TextEncoder().encode(JSON.stringify(d.body)).byteLength <= (d.path === 'napplets/bundles' ? 6 * 524288 + 16384 : 131072);
}
