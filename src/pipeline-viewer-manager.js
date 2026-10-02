import { PIPELINE_VIEWER_ENABLED } from './pipeline-viewer-activation.js';
import { disposePipelineViewer } from './pipeline-viewer-view.js';
export const pipelineViewerManagerMixin = {
  pipelineViewerEnabled: PIPELINE_VIEWER_ENABLED,
  pipelineViewerActivationPending: false,
  pipelineViewerOpen: false,
  pipelineViewerRoute: {},
  openPipelineViewer({definitionId='',runId=''}={}) {
    if(!this.pipelineViewerEnabled){this.pipelineViewerOpen=false;this.pipelineViewerRoute={};this.pipelineViewerActivationPending=true;return;}
    this.pipelineViewerActivationPending=false;
    const connection=this.selectedAgentConnection;
    this.pipelineViewerRoute=connection?{service:connection.installation_id,signer:connection.metadata?.installation_npub,definition:definitionId,run:runId}:{};
    this.pipelineViewerOpen=true;this.agentSpaceView='pipelines';this.navSection='agents';this.syncRoute?.();
  },
  closePipelineViewer(){disposePipelineViewer(this);this.pipelineViewerOpen=false;this.pipelineViewerRoute={};this.syncRoute?.();},
};
