// Deep links contain installation identity and signer, never a transport URL.
export function pipelineViewerRoute({ serviceId, serviceNpub, runId = '', definitionId = '' }) {
  const query = new URLSearchParams({ service: serviceId, signer: serviceNpub });
  if (runId) query.set('run', runId);
  else if (definitionId) query.set('definition', definitionId);
  return `pipelines?${query}`;
}
export function parsePipelineViewerRoute(search, connections) {
  const query = new URLSearchParams(search);
  const serviceId = query.get('service') || '', serviceNpub = query.get('signer') || '';
  const connection = connections.find(row => row.installation_id === serviceId && row.metadata?.installation_npub === serviceNpub && row.installation_identity_verified !== false && !row.archived_at);
  if (!connection) return { status: 'unavailable' };
  return { status: 'verified', connection, serviceId, serviceNpub, runId: query.get('run') || '', definitionId: query.get('definition') || '' };
}
