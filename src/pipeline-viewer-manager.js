import { disposePipelineViewer } from './pipeline-viewer-view.js';
export const pipelineViewerManagerMixin = {
  pipelineViewerOpen: false,
  pipelineViewerRoute: {},
  openPipelineViewer({definitionId='',runId=''}={}) {
    const connection=this.selectedAgentConnection;
    this.pipelineViewerRoute=connection?{service:connection.installation_id,signer:connection.metadata?.installation_npub,definition:definitionId,run:runId}:{};
    this.pipelineViewerOpen=true;this.agentSpaceView='pipelines';this.navSection='agents';this.syncRoute?.();
  },
  closePipelineViewer(){disposePipelineViewer(this);this.pipelineViewerOpen=false;this.pipelineViewerRoute={};this.syncRoute?.();},
};
