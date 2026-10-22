// Visibility changes suspend transport without rebuilding the editor, losing
// its selection or interfering with a send already in flight.
export function registerCanvasChatFrame(Alpine) {
  Alpine.directive('canvas-chat-frame', (element, _directive, { cleanup }) => {
    let intersecting = false;
    const send = () => element.contentWindow?.postMessage({ type: 'ambulando-canvas-chat-visibility', visible: intersecting && !document.hidden }, location.origin);
    const observer = new IntersectionObserver(entries => { intersecting = entries[0]?.isIntersecting === true; send(); });
    const ready = event => { if (event.origin === location.origin && event.source === element.contentWindow && event.data?.type === 'ambulando-canvas-chat-ready') send(); };
    observer.observe(element);
    element.addEventListener('load', send);
    addEventListener('message', ready);
    document.addEventListener('visibilitychange', send);
    cleanup(() => { observer.disconnect(); element.removeEventListener('load', send); removeEventListener('message', ready); document.removeEventListener('visibilitychange', send); });
  });
}
