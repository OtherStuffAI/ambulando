export function pipelineNodes(definition, snapshot) {
  const attempts = snapshot?.steps || [];
  function project(nodes) {
    return (nodes || []).map(node => ({ ...node,
      attempts: attempts.filter(step => step.logicalKey === node.logicalKey).sort((a,b) => a.attempt-b.attempt || a.id.localeCompare(b.id)),
      children: project(node.children),
    }));
  }
  if (!definition || definition.availability === 'unavailable') {
    const keys = [...new Set(attempts.map(step => step.logicalKey))];
    return keys.map(logicalKey => { const first=attempts.find(step=>step.logicalKey===logicalKey); return { logicalKey, name:first.title, title:first.title, description:first.description, type:first.kind, inputs:first.inputs||[], outputs:first.outputs||[], children:[], attempts:attempts.filter(step=>step.logicalKey===logicalKey) }; });
  }
  const projected = project(definition.steps);
  const known = new Set(flattenPipelineNodes(projected).map(node => node.logicalKey));
  // Captured executions remain visible even when legacy structure is incomplete.
  return [...projected, ...pipelineNodes(null, snapshot).filter(node => !known.has(node.logicalKey))];
}
export function flattenPipelineNodes(nodes, depth = 0) {
  return nodes.flatMap(node => [{ ...node, depth }, ...flattenPipelineNodes(node.children || [], depth+1)]);
}
export function evidenceText(value) {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
export function evidencePreview(value, limit = 180) {
  if (Array.isArray(value)) return `${value.length} loaded records · ${evidenceText(value[0]).slice(0,limit)}`;
  return evidenceText(value).slice(0,limit);
}
export function portValue(value, path) {
  const parts = String(path || '').replace(/^\$\.?/, '').split('.').filter(Boolean);
  let selected = value;
  for (const part of parts) {
    if (!selected || typeof selected !== 'object' || !Object.hasOwn(selected, part)) return undefined;
    selected = selected[part];
  }
  return selected;
}
export function wiringPortPath(wire, side) {
  return side === 'outputs' ? wire.sourceValuePath || wire.sourcePath : wire.targetPath;
}
export function wiringEndpoints(wire) {
  const sourceBase=wiringPortPath(wire,'outputs'),targetBase=wiringPortPath(wire,'inputs');
  const within=(path,base)=>path===base||path.startsWith(base+'.');
  const pairs=(wire.sourcePortPaths||[]).flatMap(sourcePath=>(wire.targetPortPaths||[]).filter(targetPath=>within(sourcePath,sourceBase)&&within(targetPath,targetBase)&&sourcePath.slice(sourceBase.length)===targetPath.slice(targetBase.length)).map(targetPath=>({sourcePath,targetPath})));
  return pairs.length?pairs:[{sourcePath:sourceBase,targetPath:targetBase}];
}
export function diagramPorts(node, side, wiring) {
  const ports = [...(node[side] || [])];
  for (const wire of wiring || []) {
    if (wire.carriedForward || (side === 'outputs' ? wire.sourceStepKey : wire.targetStepKey) !== node.logicalKey) continue;
    for (const endpoint of wiringEndpoints(wire)) {
    const path = side==='outputs'?endpoint.sourcePath:endpoint.targetPath;
    if (ports.some(port => port.path === path)) continue;
    // These fields are explicit configured selectors on the actual definition,
    // not inferred nodes or reconstructed values. Old state selectors use state evidence.
    ports.push({path,label:path,format:'Configured selector',configured:true,evidenceKind:side==='outputs'&&!wire.sourceValuePath?'state_write':side==='outputs'?'returned_output':'resolved_input'});
    }
  }
  return ports;
}
export function matchingWires(wiring, nodeKey, path, side) {
  const contains=(parent,child)=>parent===child||child.startsWith(parent+'.')||child.startsWith(parent+'[');
  return (wiring || []).filter(wire => (side === 'outputs' ? wire.sourceStepKey : side === 'inputs' ? wire.targetStepKey : null) === nodeKey && contains(wiringPortPath(wire,side),path));
}
export function latestPortReference(step, side, port) {
  // Backend insertion order breaks ties between captures within a millisecond.
  return step?.evidence.filter(ref => ref.kind === (port?.evidenceKind || (side === 'inputs' ? 'resolved_input' : 'returned_output'))).at(-1);
}
export function portSelection(value, path) {
  const selected = portValue(value, path);
  return { value: selected, status: selected === undefined ? 'missing' : selected === null ? 'null' : 'present' };
}

// Exact declared paths select capture-time safe fields. Missing map entries are
// outside this preview, never aliases or substitutes from another field.
export function portPreviewSelection(preview,path) {
  if(preview.fields){
    if(!Object.hasOwn(preview.fields,path))return {status:'outside',truncated:true,count:null};
    const field=preview.fields[path];
    return {...field,status:!field.present?'missing':field.value===null?(field.truncated?'outside':'null'):'present'};
  }
  const selected=portSelection(preview.value,path);
  const countPath=path==='$'?'$':'$.'+path.replace(/^\$\.?/,'');
  return {...selected,status:selected.status==='missing'&&preview.truncated?'outside':selected.status,truncated:preview.truncated,count:preview.counts?.[countPath]??(path==='$'?preview.count:null)};
}
