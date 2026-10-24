import { mountCanvasSettingsDialog } from './canvas/settings-dialog.js';
import Alpine from 'alpinejs';
import { solIcon } from './sol-icons.js';
import { installAppearance } from './appearance.js';
import { installSolAccessibility } from './sol-accessibility.js';
import { createPipelineViewerView } from './pipeline-viewer-view.js';
import './pipeline-viewer.css';
import { createContextTreeView } from './context-tree-view.js';
import { installStableHtml } from './stable-html.js';
import { initializeTowerTransports } from './tower-transport.js';
import { installNativeTransportLifecycle } from './native-transport-lifecycle.js';
import './styles.css';
import './canvas/chat-embed.css';
import './sol.css';
import './hosting-onboarding.css';
import { canvasChatEmbedded, prepareCanvasChatDom } from './canvas/chat-embed.js';
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
  installNativeTransportLifecycle();
  installStableHtml(Alpine);
  Alpine.data('pipelineViewerView', () => createPipelineViewerView());
  Alpine.data('contextTreeView', () => createContextTreeView());
  mountCanvasSettingsDialog();
  if (canvasChatEmbedded) prepareCanvasChatDom();
  initApp();
  if (!Alpine.store('chat').canvasChatEmbedded) installNotificationClickRouteHandler();
  initChatThreadFlowDispatchDomBridge();
  if (!Alpine.store('chat').canvasChatEmbedded) registerBuildServiceWorker();
  if (!Alpine.store('chat').canvasChatEmbedded) startVersionCheck();
  initImageModal();
  initMarkdownCodeBlocks();
}

void boot();
