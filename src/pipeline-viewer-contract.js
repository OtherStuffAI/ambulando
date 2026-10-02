// Autopilot viewer DTOs are separate from persisted projections and rendered nodes.
export const REDACTION_REVIEW_REQUIRED = 'pipeline-viewer-evidence-redaction-review-required';
export const REDACTION_REVIEW_MESSAGE = 'Evidence withheld pending credential redaction review';
export const isRedactionReviewRefusal = error => error?.status === 409 && error?.code === REDACTION_REVIEW_REQUIRED;
export const PIPELINE_VIEWER_CAPABILITY = 'pipelines.viewer.read.v1';
export class PipelineViewerError extends Error {
  constructor(code, message) { super(message); this.name = 'PipelineViewerError'; this.code = code; }
}
const invalid = () => { throw new PipelineViewerError('response_invalid', 'Pipeline viewer returned an invalid read contract.'); };
const string = value => typeof value === 'string' ? value : '';
const optional = value => value == null ? null : string(value);
const list = value => Array.isArray(value) ? value : [];
const pick = (row, keys) => Object.fromEntries(keys.map(key => [key, optional(row?.[key])]));
export function viewerContextKey(context) {
  const keys = ['backend', 'workspaceId', 'actorNpub', 'serviceId', 'serviceNpub'];
  if (keys.some(key => !string(context?.[key]).trim())) throw new PipelineViewerError('context_unavailable', 'Choose a verified service and workspace actor.');
  return JSON.stringify([...keys.map(key => context[key]), ...['ownerNpub','towerServiceNpub','appNpub','agentNpub'].map(key=>context[key]||'')]);
}
export function assertViewerEnvelope(payload, serviceId) {
  if (payload?.version !== 1 || payload.serviceId !== serviceId) invalid();
  return payload;
}
function port(row) {
  if (!string(row?.label) || !string(row.path)) invalid();
  return pick(row, ['label', 'path', 'format']);
}
function node(row) {
  if (!string(row?.logicalKey)) invalid();
  return { ...pick(row, ['logicalKey', 'name', 'title', 'description', 'type']),
    inputs: list(row.inputs).map(port), outputs: list(row.outputs).map(port), children: list(row.children).map(node) };
}
export function definitionDto(row) {
  if (!string(row?.id)) invalid();
  return { ...pick(row, ['id', 'name', 'title', 'description', 'hash', 'availability']), version: row.version ?? null,
    steps: list(row.steps).map(node), wiring: list(row.wiring).map(wire => ({
      ...pick(wire, ['sourceStepKey', 'sourcePath', 'sourceValuePath', 'targetStepKey', 'targetPath']), carriedForward: wire.carriedForward === true, sourcePortPaths:list(wire.sourcePortPaths).map(string), targetPortPaths:list(wire.targetPortPaths).map(string),
    })) };
}
export function runDto(row, serviceId) {
  if (!string(row?.id) || row.serviceId !== serviceId || !string(row.status)) invalid();
  return { ...pick(row, ['id', 'serviceId', 'definitionId', 'definitionHash', 'name', 'status', 'startedAt', 'completedAt', 'parentRunId', 'parentStepId']), definitionVersion: row.definitionVersion ?? null };
}
function boundedEvidencePreview(row) {
  if (!row || typeof row !== 'object' || !Object.hasOwn(row,'value') || typeof row.truncated !== 'boolean') return null;
  if (new TextEncoder().encode(JSON.stringify(row)).length > 2048) invalid();
  const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
  const preview={value:row.value,truncated:row.truncated,count:count(row.count),counts:Object.fromEntries(Object.entries(row.counts||{}).slice(0,20).map(([key,value])=>[key,count(value)]))};
  if(row.fields!=null){
    if(typeof row.fields!=='object'||Array.isArray(row.fields))invalid();
    preview.fields=Object.fromEntries(Object.entries(row.fields).map(([path,field])=>{
      if(!path||!field||typeof field.present!=='boolean'||typeof field.truncated!=='boolean'||(field.present&&!Object.hasOwn(field,'value')))invalid();
      return [path,{present:field.present,...(field.present?{value:field.value}:{}),truncated:field.truncated,count:count(field.count)}];
    }));
  }
  return preview;
}
export function evidenceDto(row) {
  if (!string(row?.id) || !string(row.runId)) invalid();
  return { ...pick(row, ['id', 'runId', 'stepId', 'kind', 'scope', 'contentType', 'availability', 'capturedAt', 'expiresAt']),
    attempt: Number.isSafeInteger(row.attempt) ? row.attempt : null, bytes: Number.isSafeInteger(row.bytes) ? row.bytes : null, redacted: row.redacted === true, preview: boundedEvidencePreview(row.preview) };
}
export function snapshotDto(payload, serviceId) {
  assertViewerEnvelope(payload, serviceId);
  if (!(typeof payload.revision === 'string' && /^[a-f0-9]{64}$/.test(payload.revision))
    && !(Number.isSafeInteger(payload.revision) && payload.revision >= 0)) invalid();
  const run = runDto(payload.run, serviceId);
  const ids = new Set();
  const steps = list(payload.steps).map(row => {
    if (!string(row?.id) || !string(row.logicalKey) || !Number.isSafeInteger(row.attempt) || ids.has(row.id)) invalid();
    ids.add(row.id);
    // Full inputs/outputs never enter IndexedDB; only lazy evidence references.
    return { ...pick(row, ['id', 'logicalKey', 'parentStepId', 'status', 'title', 'description', 'kind', 'startedAt', 'completedAt', 'error', 'skipReason', 'continuationReason', 'exitReason', 'childRunId','itemKey']),
      attempt: row.attempt, inputs: Array.isArray(row.inputs) ? row.inputs.map(port) : [], outputs: Array.isArray(row.outputs) ? row.outputs.map(port) : [], evidence: list(row.evidence).map(evidenceDto) };
  });
  if (steps.some(step => step.evidence.some(ref => ref.runId !== run.id || ref.stepId !== step.id))) invalid();
  return { run, definition: payload.definition ? definitionDto(payload.definition) : null, steps,
    children: list(payload.children).map(row => runDto(row, serviceId)), revision: payload.revision };
}
export function viewerFailure(error) {
  if (isRedactionReviewRefusal(error)) return 'unavailable';
  if (error?.status === 403 || error?.code === 'auth_failed') return 'denied';
  if (error?.status === 404 || ['route_unavailable', 'capability_unavailable', 'context_unavailable'].includes(error?.code)) return 'unavailable';
  if (['response_invalid', 'installation_mismatch'].includes(error?.code)) return 'unavailable';
  return 'disconnected';
}
