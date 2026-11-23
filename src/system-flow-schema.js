// Bounded flow index and Excalidraw scene JSON; no arbitrary editor properties or external content.
export function validateFlow(value) {
  const fail = () => { throw Object.assign(new Error('Invalid flow: use supported nodes, edges and plain JSON fields'), { status: 400 }); };
  const object = (v, keys) => { if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v)) || Object.keys(v).some(k => !keys.includes(k))) fail(); };
  const string = (v, limit = 5000) => { if (typeof v !== 'string' || v.length > limit) fail(); };
  const id = v => { string(v, 100); if (!/^[A-Za-z0-9_-]{1,100}$/.test(v) || ['__proto__', 'constructor', 'prototype'].includes(v)) fail(); };
  const number = v => { if (!Number.isFinite(v) || Math.abs(v) > 1e7) fail(); };
  const optional = (v, k, check) => { if (v[k] !== undefined) check(v[k]); };
  const style = (v, keys) => { object(v, keys); for (const [k, x] of Object.entries(v)) { if (['stroke','fill'].includes(k)) { string(x, 30); if (!/^(#[a-fA-F0-9]{3,8}|[a-zA-Z]{1,20})$/.test(x)) fail(); } else { number(x); if (x < 0 || x > 100) fail(); } } };
  if ([2,3].includes(value?.schemaVersion)) {
    object(value, ['schemaVersion','title','rootDiagramId','diagrams', ...(value.schemaVersion === 3 ? ['whiteboards','scenes'] : [])]);
    optional(value, 'title', v => string(v, 200)); id(value.rootDiagramId);
    if (!Array.isArray(value.diagrams) || !value.diagrams.length || value.diagrams.length > 100 || JSON.stringify({...value,scenes:undefined}).length > 2_000_000) fail();
    const boardIds = new Set(), sceneIds = new Set();
    if (value.schemaVersion === 3) {
      if (!Array.isArray(value.whiteboards) || value.whiteboards.length > 100) fail();
      for (const board of value.whiteboards) {
        object(board, ['id','title','sceneId','currentSceneId','proposedSceneId']); id(board.id); string(board.title,200);
        if (boardIds.has(board.id)) fail(); boardIds.add(board.id);
        if (!board.sceneId && (!board.currentSceneId || !board.proposedSceneId)) fail();
        if (Boolean(board.currentSceneId) !== Boolean(board.proposedSceneId)) fail();
        for (const key of ['sceneId','currentSceneId','proposedSceneId'].filter(key=>board[key] !== undefined)) { id(board[key]); if (sceneIds.has(board[key])) fail(); sceneIds.add(board[key]); }
      }
      if (value.scenes !== undefined) {
        object(value.scenes, [...sceneIds]);
        if (Object.keys(value.scenes).length !== sceneIds.size) fail();
        for (const scene of Object.values(value.scenes)) validateScene(scene);
      }
    }
    const ids = new Set(); let nodes = 0, edges = 0;
    for (const d of value.diagrams) {
      object(d, ['id','title','nodes','edges','viewport']); id(d.id); string(d.title,200);
      if (ids.has(d.id) || boardIds.has(d.id) || sceneIds.has(d.id)) fail(); ids.add(d.id);
    }
    if (!ids.has(value.rootDiagramId)) fail();
    for (const d of value.diagrams) {
      if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) fail();
      const clean = d.nodes.map(n => {
        object(n, ['id','type','position','data','parentId','width','height']);
        object(n.data, ['kind','label','description','owner','detailFlowId','whiteboardId']);
        if (n?.data?.detailFlowId !== undefined) { id(n.data.detailFlowId); if (!ids.has(n.data.detailFlowId)) fail(); }
        if (n.data.whiteboardId !== undefined) { id(n.data.whiteboardId); if (!boardIds.has(n.data.whiteboardId) || n.data.kind !== 'whiteboard') fail(); }
        if (n.data.kind === 'whiteboard' && !n.data.whiteboardId) fail();
        const {detailFlowId, whiteboardId, ...data} = n.data; return {...n,data};
      });
      validateFlow({schemaVersion:1,title:d.title,nodes:clean,edges:d.edges,...(d.viewport !== undefined ? {viewport:d.viewport} : {})});
      nodes += d.nodes.length; edges += d.edges.length;
    }
    if (nodes > 2000 || edges > 6000) fail();
    return value;
  }
  object(value, ['schemaVersion', 'title', 'nodes', 'edges', 'viewport']);
  if (value.schemaVersion !== 1 || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || value.nodes.length > 500 || value.edges.length > 1500) fail();
  optional(value, 'title', v => string(v, 200));
  const nodeIds = new Set(), edgeIds = new Set();
  for (const n of value.nodes) {
    object(n, ['id','type','position','data','parentId','width','height']); id(n.id); if (nodeIds.has(n.id) || n.type !== 'flow') fail(); nodeIds.add(n.id);
    object(n.position, ['x','y']); number(n.position.x); number(n.position.y);
    object(n.data, ['kind','label','description','owner']);
    if (!['view','action','state','decision','exception','whiteboard','system','component'].includes(n.data.kind)) fail();
    string(n.data.label, 200); optional(n.data, 'description', string); optional(n.data, 'owner', v => string(v, 200));
  }
  const byId = new Map(value.nodes.map(n => [n.id,n]));
  for (const n of value.nodes) {
    for (const key of ['width','height']) optional(n,key,v=>{number(v); if(v<100 || v>10000 || n.data.kind!=='system') fail();});
    optional(n,'parentId',v=>{id(v); const parent=byId.get(v); if(!parent || parent.data.kind!=='system' || v===n.id) fail();});
    const seen=new Set([n.id]); let parent=n.parentId;
    while(parent) {if(seen.has(parent)) fail(); seen.add(parent); parent=byId.get(parent)?.parentId;}
  }
  for (const e of value.edges) {
    object(e, ['id','source','target','sourceHandle','targetHandle','type','label','markerEnd','style','labelStyle','labelBgStyle','relationship']);
    id(e.id); if (edgeIds.has(e.id) || !nodeIds.has(e.source) || !nodeIds.has(e.target)) fail(); edgeIds.add(e.id);
    optional(e, 'relationship', v => { if (!['flow','design-detail'].includes(v) || (v==='design-detail' && !value.nodes.some(n=>[e.source,e.target].includes(n.id) && n.data.kind==='whiteboard'))) fail(); });
    optional(e, 'type', v => { if (v !== 'smoothstep') fail(); }); optional(e, 'label', v => string(v, 500));
    for (const k of ['sourceHandle','targetHandle']) optional(e, k, v => { if (v !== null && (typeof v !== 'string' || !new RegExp(`^${k === 'sourceHandle' ? 's' : 't'}-(left|right|top|bottom)$`).test(v))) fail(); });
    optional(e, 'markerEnd', v => { object(v, ['type']); if (v.type !== 'arrowclosed') fail(); });
    optional(e, 'style', v => style(v, ['stroke','strokeWidth'])); optional(e, 'labelStyle', v => style(v, ['fontSize'])); optional(e, 'labelBgStyle', v => style(v, ['fill']));
  }
  optional(value, 'viewport', v => { object(v, ['x','y','zoom']); number(v.x); number(v.y); if (!Number.isFinite(v.zoom) || v.zoom < .05 || v.zoom > 10) fail(); });
  return value;
}

export function validateScene(scene) {
  const fail = () => { throw Object.assign(new Error('Invalid whiteboard scene'), {status:400}); };
  const plain = v => v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v));
  const safeId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v) && !['__proto__','constructor','prototype'].includes(v);
  if (!plain(scene) || Object.keys(scene).some(k=>!['elements','appState','files'].includes(k)) || !Array.isArray(scene.elements) || scene.elements.length > 5000 || !plain(scene.appState) || !plain(scene.files) || JSON.stringify(scene).length > 10_000_000) fail();
  const keys = ['viewBackgroundColor','scrollX','scrollY','zoom'];
  if (Object.keys(scene.appState).some(k=>!keys.includes(k))) fail();
  for (const k of ['scrollX','scrollY']) if (scene.appState[k] !== undefined && (!Number.isFinite(scene.appState[k]) || Math.abs(scene.appState[k])>1e7)) fail();
  if (scene.appState.zoom !== undefined && (!plain(scene.appState.zoom) || Object.keys(scene.appState.zoom).some(k=>k!=='value') || !Number.isFinite(scene.appState.zoom.value) || scene.appState.zoom.value < .05 || scene.appState.zoom.value > 30)) fail();
  if (scene.appState.viewBackgroundColor !== undefined && (typeof scene.appState.viewBackgroundColor !== 'string' || !/^(#[a-fA-F0-9]{3,8}|[a-zA-Z]{1,20})$/.test(scene.appState.viewBackgroundColor))) fail();
  const inspect = (v,depth=0) => {
    if (depth>20) fail();
    if (typeof v==='number' && !Number.isFinite(v)) fail();
    if (v && typeof v==='object') {
      if (!Array.isArray(v) && !plain(v)) fail();
      for (const [k,x] of Object.entries(v)) { if (['__proto__','constructor','prototype'].includes(k)) fail(); inspect(x,depth+1); }
    }
  };
  inspect(scene);
  const ids = new Set();
  for (const e of scene.elements) {
    if (!plain(e) || !safeId(e.id) || ids.has(e.id) || !['rectangle','diamond','ellipse','text','arrow','line','freedraw','image','frame','embeddable'].includes(e.type)) fail();
    ids.add(e.id);
    if (e.type === 'embeddable' || e.link) fail();
    for (const k of ['x','y','width','height']) if (!Number.isFinite(e[k]) || Math.abs(e[k]) > 1e7) fail();
    if (e.type === 'image' && !e.isDeleted && (!safeId(e.fileId) || !scene.files[e.fileId])) fail();
  }
  if (Object.keys(scene.files).length > 200) fail();
  for (const [id,file] of Object.entries(scene.files)) {
    if (!safeId(id) || !plain(file) || file.id !== id || !['image/png','image/jpeg','image/webp','image/gif'].includes(file.mimeType) || typeof file.dataURL !== 'string' || !new RegExp('^data:'+file.mimeType+';base64,[A-Za-z0-9+/]+={0,2}$').test(file.dataURL) || file.dataURL.length > 8_000_000) fail();
  }
  return scene;
}

// Scene maps are reconstructed from separate files, so object-key ordering is
// not part of collection identity. Keep legacy receipt hashing unchanged.
export function serializeFlow(flow) {
  return flow.schemaVersion === 3 ? JSON.stringify(flow,(_,value)=>value && typeof value==='object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])) : value) : JSON.stringify(flow);
}

// Persisted indexes may omit scenes. Client snapshots/imports/recovery may not.
export function validateEditableFlow(flow) {
  validateFlow(flow);
  if (flow.schemaVersion === 3 && !flow.scenes) throw Object.assign(new Error('Linked collection requires all scene data; import an exported collection, not flow.json alone'), {status:400});
  return flow;
}
