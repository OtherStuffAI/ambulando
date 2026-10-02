import { PIPELINE_VIEWER_CAPABILITY, PipelineViewerError, assertViewerEnvelope } from './pipeline-viewer-contract.js';
const required = value => typeof value === 'string' && value.trim();
function segment(value) {
  if (!required(value)) throw new PipelineViewerError('context_unavailable', 'A viewer record identity is required.');
  return encodeURIComponent(value);
}
function bounded(value, max, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > max) throw new PipelineViewerError('request_invalid', 'Invalid viewer pagination.');
  return String(value);
}
// Invoked only by the verified connection client, using its retained transport.
export function pipelineViewerRequestPath(verified, context, operation, options = {}) {
  if (!verified.capabilities?.includes(PIPELINE_VIEWER_CAPABILITY)) throw new PipelineViewerError('capability_unavailable', 'This Autopilot does not advertise pipeline viewer v1. Refresh its signed connection after backend activation.');
  const match = verified.healthPath?.match(/^\/api\/owners\/([^/]+)\/control-plane\/v1\/health$/);
  if (!match || decodeURIComponent(match[1]) !== context?.ownerNpub
    || ['workspaceId', 'towerServiceNpub', 'appNpub'].some(key => !required(context?.[key]))) throw new PipelineViewerError('context_unavailable', 'Verified owner and workspace context are required.');
  const prefix = `/api/owners/${match[1]}/control-plane/v1/pipeline-viewer`;
  if (verified.pipelineViewerPath !== prefix) throw new PipelineViewerError('capability_unavailable', 'This connection has no matching signed viewer path. Refresh its signed capabilities.');
  const query = new URLSearchParams({ workspace_id: context.workspaceId, tower_service_npub: context.towerServiceNpub, app_npub: context.appNpub });
  if (context.agentNpub) query.set('agent_npub', context.agentNpub);
  let suffix;
  switch (operation) {
    case 'definitions': case 'runs':
      suffix = `/${operation}`; query.set('limit', bounded(options.limit ?? 50, 100));
      if (options.cursor != null) { if (!required(options.cursor)) throw new PipelineViewerError('request_invalid', 'Invalid viewer cursor.'); query.set('cursor', options.cursor); }
      if (operation === 'runs' && options.definitionId) query.set('definitionId', options.definitionId);
      break;
    case 'definition': suffix = `/definitions/${segment(options.id)}`; break;
    case 'run': suffix = `/runs/${segment(options.id)}`; break;
    case 'updates': suffix = `/runs/${segment(options.id)}/updates`; if (options.after != null && options.after !== 0 && !(typeof options.after === 'string' && /^[a-f0-9]{64}$/.test(options.after))) throw new PipelineViewerError('request_invalid', 'Invalid viewer revision.'); query.set('after', String(options.after ?? ''));  break;
    case 'evidence': suffix = `/runs/${segment(options.id)}/evidence/${segment(options.evidenceId)}`; query.set('offset', bounded(options.offset ?? 0, Number.MAX_SAFE_INTEGER, true)); query.set('limit', bounded(options.limit ?? 100, 100)); break;
    default: throw new PipelineViewerError('request_invalid', 'Unknown viewer read.');
  }
  return `${prefix}${suffix}?${query}`;
}
export function createPipelineViewerClient(connection, context) {
  if (typeof connection?.readPipelineViewer !== 'function') throw new PipelineViewerError('capability_unavailable', 'This connection client does not support the pipeline viewer.');
  return { read: async (operation, options = {}, signal) => assertViewerEnvelope(await connection.readPipelineViewer(context, operation, options, signal), context.serviceId) };
}
