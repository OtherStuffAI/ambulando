const key = /^[a-z][a-z0-9_]{0,63}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function normalizeOrgSnapshot(payload, c, requestId) {
  const fail = () => { throw new Error('Invalid or incomplete organisation data response'); };
  if (!requestId || payload?.complete !== true || payload.workspace_id !== c.workspaceId) fail();
  for (const [name, value] of Object.entries({ workspace_id: c.workspaceId, workspace_owner_npub: c.workspaceOwnerNpub,
    app_npub: c.appNpub, tower_service_npub: c.tower, workspace_service_npub: c.service })) {
    if (!value || payload.identity?.[name] !== value) fail();
  }
  if (!Array.isArray(payload.types) || payload.types.length > 200 || !Array.isArray(payload.records) || payload.records.length > 10000) fail();
  const seen = new Set(), records = {};
  const types = payload.types.map(t => {
    if (!key.test(t?.key) || seen.has(t.key) || typeof t.label !== 'string' || !Array.isArray(t.fields)
      || !Number.isSafeInteger(t.revision) || t.revision < 1) fail();
    seen.add(t.key); records[t.key] = [];
    return { key: t.key, label: t.label, fields: t.fields.map(f => ({ key: f.key, label: f.label, type: f.type, required: f.required === true, ...(f.target_type ? { target_type: f.target_type } : {}) })),
      access: { read: t.access?.read, write: t.access?.write }, capabilities: capabilities(t.capabilities), revision: t.revision };
  });
  const ids = new Set();
  for (const r of payload.records) {
    if (!uuid.test(r?.id) || ids.has(r.id) || !seen.has(r.type_key) || !Number.isSafeInteger(r.revision) || r.revision < 1
      || !r.values || typeof r.values !== 'object' || Array.isArray(r.values)) fail();
    ids.add(r.id);
    // Only declared scalar fields enter the frame. No arbitrary server metadata.
    const type = types.find(t => t.key === r.type_key), values = {};
    for (const f of type.fields) { const v = r.values[f.key]; if (v === undefined) continue;
      if (v !== null && !['string','number','boolean'].includes(typeof v)) fail(); values[f.key] = v; }
    records[r.type_key].push({ id: r.id, type_key: r.type_key, values, revision: r.revision });
  }
  const installations = (payload.installations || []).map(b => {
    if (!key.test(b?.key) || b.bridge_version !== 1 || !Number.isSafeInteger(b.version) || typeof b.html !== 'string'
      || b.html.length > 524288 || !/^[a-f0-9]{64}$/.test(b.sha256) || !Array.isArray(b.capabilities)) fail();
    return { key: b.key, version: b.version, revision: b.revision, title: b.title, bridge_version: 1, capabilities: b.capabilities, sha256: b.sha256, html: b.html };
  });
  const identities = {};
  for (const [id, npub] of Object.entries(payload.identities || {})) { if (!uuid.test(id) || typeof npub !== 'string' || !/^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(npub)) fail(); identities[id] = npub; }
  const changes = (payload.changes || []).map(r => ({ id: r.id, operation: r.operation, target_id: r.target_id, created_at: r.created_at }));
  const bundles = (payload.bundles || []).map(({key,version,title,capabilities,sha256}) => ({key,version,title,capabilities,sha256}));
  return { bundles, identities, changes, request_id: requestId, types, records, capabilities: capabilities(payload.capabilities), installations };
}
function capabilities(c) { return { read: c?.read === true, write: c?.write === true, schema: c?.schema === true, publish: c?.publish === true, install: c?.install === true }; }

export async function normalizeOrgSnapshotAsync(payload, c, requestId) {
 const row = normalizeOrgSnapshot(payload, c, requestId);
 for (const b of row.installations) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(b.html));
  const hex = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  if (hex !== b.sha256) throw new Error('Installed napplet integrity check failed');
 }
 return row;
}
