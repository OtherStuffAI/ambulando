import Alpine from 'alpinejs';
import { solIcon } from './sol-icons.js';
import { installAppearance } from './appearance.js';
import { installSolAccessibility } from './sol-accessibility.js';
import { createPipelineViewerView } from './pipeline-viewer-view.js';
import './pipeline-viewer.css';
import { createContextTreeView } from './context-tree-view.js';
import { installStableHtml } from './stable-html.js';
import { initializeTowerTransports } from './tower-transport.js';
import './styles.css';
import './sol.css';
import { initApp } from './app.js';
import { maybePerformHardReset } from './hard-reset.js';
import { startVersionCheck } from './version-check.js';
import { initImageModal } from './image-modal.js';
import { installNotificationClickRouteHandler, registerBuildServiceWorker } from './service-worker-registration.js';
import { initChatThreadFlowDispatchDomBridge } from './chat-thread-flow-dispatch-dom.js';
import { initMarkdownCodeBlocks } from './markdown-code-blocks.js';
import { installWingmanIphoneWebViewMarker } from './wingman-iphone-webview.js';

installWingmanIphoneWebViewMarker();
Alpine.magic('solIcon', () => solIcon);
installAppearance(Alpine);
installSolAccessibility(Alpine);

async function boot() {
  if (await maybePerformHardReset()) return;
  await initializeTowerTransports();
  installStableHtml(Alpine);
  Alpine.data('pipelineViewerView', () => createPipelineViewerView());
  Alpine.data('contextTreeView', () => createContextTreeView());
  initApp();
  installNotificationClickRouteHandler();
  initChatThreadFlowDispatchDomBridge();
  registerBuildServiceWorker();
  startVersionCheck();
  initImageModal();
  initMarkdownCodeBlocks();
}

void boot();
