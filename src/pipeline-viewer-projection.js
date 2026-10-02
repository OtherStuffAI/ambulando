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
  return project(definition.steps);
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
export function matchingWires(wiring, nodeKey, path) {
  return (wiring || []).filter(wire => (wire.sourceStepKey === nodeKey && wire.sourcePath === path) || (wire.targetStepKey === nodeKey && wire.targetPath === path));
}
