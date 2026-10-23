import { resolveTowerPgWorkspaceContext } from '../pg-workspace-context.js';
import { canvasChatProjection } from './chat-references.js';
import { attachCanvasChatSigner } from './chat-signer.js';

// Visibility changes suspend transport without rebuilding the editor, losing
// its selection or interfering with a send already in flight.
export function registerCanvasChatFrame(Alpine) {
  Alpine.directive('canvas-chat-frame', (element, _directive, { cleanup, effect }) => {
    const disconnectSigner = attachCanvasChatSigner({ element, context: () => {
      const store = Alpine.store('canvas'), workspace = store.currentWorkspace;
      const context = resolveTowerPgWorkspaceContext(store);
      return { workspaceKey: store.currentWorkspaceKey, workspaceId: context.workspaceId, baseUrl: context.baseUrl, appNpub: context.appNpub,
        workspaceOwnerNpub: context.workspaceOwnerNpub, towerServiceNpub: workspace?.towerServiceNpub, workspaceServiceNpub: workspace?.workspaceServiceNpub,
        workspaceSessionNpub: workspace?.pgSessionNpub,
        taskSurface: !!new URL(element.src,location.origin).searchParams.get('canvastask'),
        pubkey: store.session?.pubkey, npub: store.session?.npub, method: store.session?.method };
    } });
    let intersecting = false;
    const send = () => element.contentWindow?.postMessage({ type: 'ambulando-canvas-chat-visibility', visible: intersecting && !document.hidden, context: canvasChatProjection(Alpine.store('canvas'), location.origin) }, location.origin);
    const observer = new IntersectionObserver(entries => { intersecting = entries[0]?.isIntersecting === true; send(); });
    const ready = event => { if (event.origin === location.origin && event.source === element.contentWindow && event.data?.type === 'ambulando-canvas-chat-ready') send(); };
    effect(send);
    observer.observe(element);
    element.addEventListener('load', send);
    addEventListener('message', ready);
    document.addEventListener('visibilitychange', send);
    cleanup(() => { disconnectSigner(); observer.disconnect(); element.removeEventListener('load', send); removeEventListener('message', ready); document.removeEventListener('visibilitychange', send); });
  });
}
